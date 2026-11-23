// Captures what each fixture on the network says over Art-Net, RDM and HTTP, as test fixtures.
//
//   node scripts/capture-fixtures.mjs [poll address…]
//
// Polls 255.255.255.255 and each adapter's subnet broadcast by default. Set LYRA_PASSWORD to also read the
// password-protected /api/config of newer firmware; logging in signs out anyone using that fixture's web page.
// Raw packets are stored as hex; tokens are never written.

import dgram from 'node:dgram'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const OUT_DIR = path.join(import.meta.dirname, '..', 'src', '__tests__', 'fixtures', 'captured')
const ARTNET_PORT = 6454
const ARTNET_ID = Buffer.from('Art-Net\0', 'ascii')
const OP = { poll: 0x2000, pollReply: 0x2100, todRequest: 0x8000, todData: 0x8100, rdm: 0x8300 }
const CONTROLLER_UID = Buffer.from([0x7f, 0xf0, 0x00, 0x00, 0x00, 0x01])

const PID = {
	SUPPORTED_PARAMETERS: 0x0050,
	PARAMETER_DESCRIPTION: 0x0051,
	DEVICE_INFO: 0x0060,
	DEVICE_MODEL_DESCRIPTION: 0x0080,
	MANUFACTURER_LABEL: 0x0081,
	DEVICE_LABEL: 0x0082,
	SOFTWARE_VERSION_LABEL: 0x00c0,
	DMX_PERSONALITY: 0x00e0,
	DMX_PERSONALITY_DESCRIPTION: 0x00e1,
	DMX_START_ADDRESS: 0x00f0,
	SLOT_INFO: 0x0120,
	SLOT_DESCRIPTION: 0x0121,
	DEVICE_HOURS: 0x0400,
	LAMP_HOURS: 0x0401,
	LAMP_STRIKES: 0x0402,
}
const PID_NAMES = Object.fromEntries(Object.entries(PID).map(([name, id]) => [id, name]))

const hex = (buf) => Buffer.from(buf).toString('hex')
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function header(opCode) {
	const buf = Buffer.alloc(12)
	ARTNET_ID.copy(buf)
	buf.writeUInt16LE(opCode, 8)
	buf.writeUInt16BE(14, 10)
	return buf
}

const artPoll = () => Buffer.concat([header(OP.poll), Buffer.from([0x02, 0x00])])

function todRequest(portAddress) {
	const body = Buffer.alloc(44)
	body[9] = (portAddress >> 8) & 0x7f
	body[11] = 1
	body[12] = portAddress & 0xff
	return Buffer.concat([header(OP.todRequest), body])
}

function rdmGet(portAddress, uid, transaction, pid, data = Buffer.alloc(0)) {
	const rdm = Buffer.concat([
		Buffer.from([0xcc, 0x01, 24 + data.length]),
		uid,
		CONTROLLER_UID,
		Buffer.from([transaction & 0xff, 1, 0, 0, 0, 0x20, pid >> 8, pid & 0xff, data.length]),
		data,
	])
	const checksum = rdm.reduce((sum, byte) => sum + byte, 0) & 0xffff
	const head = Buffer.from([1, 0, 0, 0, 0, 0, 0, 0, 0, (portAddress >> 8) & 0x7f, 0, portAddress & 0xff])
	return Buffer.concat([header(OP.rdm), head, rdm.subarray(1), Buffer.from([checksum >> 8, checksum & 0xff])])
}

function decodePollReply(msg) {
	const str = (start, end) => msg.toString('latin1', start, end).replace(/\0.*$/s, '')
	return {
		shortName: str(26, 44),
		longName: str(44, 108),
		nodeReport: str(108, 172),
		firmwareVersion: msg.readUInt16BE(16),
		oem: msg.readUInt16BE(20),
		estaManufacturer: msg.readUInt16LE(24),
		status1: msg[23],
		portAddress: ((msg[18] & 0x7f) << 8) | ((msg[19] & 0x0f) << 4) | (msg[190] & 0x0f),
		sacnOutput: (msg[182] & 0x01) !== 0,
		mac: [...msg.subarray(201, 207)].map((b) => b.toString(16).padStart(2, '0')).join(':'),
	}
}

function decodeRdmResponse(msg) {
	const rdm = msg.subarray(24)
	const length = rdm[22]
	return {
		responseType: rdm[15],
		commandClass: rdm[19],
		pid: rdm.readUInt16BE(20),
		data: hex(rdm.subarray(23, 23 + length)),
	}
}

class Socket {
	#socket = dgram.createSocket({ type: 'udp4', reuseAddr: true })
	#listeners = new Set()

	async open() {
		await new Promise((resolve) => this.#socket.bind(0, resolve))
		this.#socket.setBroadcast(true)
		this.#socket.on('message', (msg, rinfo) => {
			if (!msg.subarray(0, 8).equals(ARTNET_ID)) return
			for (const listener of this.#listeners) listener(msg, rinfo)
		})
	}

	send(packet, address) {
		this.#socket.send(packet, ARTNET_PORT, address)
	}

	/** Send `packet` (resending every 300ms) until `accept` returns a value or the timeout passes */
	async request(packet, address, accept, timeoutMs = 1500) {
		return new Promise((resolve) => {
			const listener = (msg, rinfo) => {
				if (rinfo.address !== address) return
				const result = accept(msg)
				if (result !== undefined) done(result)
			}
			const done = (result) => {
				clearInterval(resend)
				clearTimeout(timer)
				this.#listeners.delete(listener)
				resolve(result)
			}
			this.#listeners.add(listener)
			const resend = setInterval(() => this.send(packet, address), 300)
			const timer = setTimeout(() => done(null), timeoutMs)
			this.send(packet, address)
		})
	}

	listen(listener) {
		this.#listeners.add(listener)
		return () => this.#listeners.delete(listener)
	}

	close() {
		this.#socket.close()
	}
}

function pollTargets() {
	const args = process.argv.slice(2)
	if (args.length > 0) return args
	const broadcasts = Object.values(os.networkInterfaces())
		.flatMap((addresses) => addresses ?? [])
		.filter((a) => a.family === 'IPv4' && !a.internal)
		.map((a) => {
			const toNum = (ip) => ip.split('.').reduce((v, o) => ((v << 8) | Number(o)) >>> 0, 0)
			const n = (toNum(a.address) | ~toNum(a.netmask)) >>> 0
			return [24, 16, 8, 0].map((s) => (n >>> s) & 0xff).join('.')
		})
	return [...new Set(['255.255.255.255', ...broadcasts])]
}

async function pollNodes(socket) {
	const nodes = new Map()
	const stop = socket.listen((msg, rinfo) => {
		if (msg.length >= 207 && msg.readUInt16LE(8) === OP.pollReply && !nodes.has(rinfo.address)) {
			nodes.set(rinfo.address, { ip: rinfo.address, sourcePort: rinfo.port, pollReply: msg })
		}
	})
	const poll = artPoll()
	for (let i = 0; i < 3; i++) {
		for (const target of pollTargets()) socket.send(poll, target)
		await sleep(500)
	}
	await sleep(1000)
	stop()
	return [...nodes.values()]
}

async function captureRdm(socket, ip, portAddress) {
	const request = todRequest(portAddress)
	const tod = await socket.request(request, ip, (msg) => (msg.readUInt16LE(8) === OP.todData ? msg : undefined))
	const result = { todRequest: hex(request), todData: tod ? hex(tod) : null, uids: [], gets: [] }
	if (!tod) return result

	const count = tod[27]
	for (let i = 0; i < count; i++) result.uids.push(hex(tod.subarray(28 + i * 6, 34 + i * 6)))

	let transaction = 0
	for (const uidHex of result.uids) {
		const uid = Buffer.from(uidHex, 'hex')
		const get = async (pid, data = Buffer.alloc(0)) => {
			const packet = rdmGet(portAddress, uid, transaction++, pid, data)
			const reply = await socket.request(
				packet,
				ip,
				(msg) => {
					if (msg.readUInt16LE(8) !== OP.rdm || msg.length < 47) return undefined
					return decodeRdmResponse(msg).pid === pid ? msg : undefined
				},
				1000,
			)
			const entry = {
				uid: uidHex,
				pid: PID_NAMES[pid] ?? `0x${pid.toString(16).padStart(4, '0')}`,
				param: hex(data),
				request: hex(packet),
				response: reply ? hex(reply) : null,
				decoded: reply ? decodeRdmResponse(reply) : null,
			}
			result.gets.push(entry)
			return entry.decoded
		}

		const supported = await get(PID.SUPPORTED_PARAMETERS)
		const supportedPids = supported
			? Array.from({ length: supported.data.length / 4 }, (_, i) =>
					parseInt(supported.data.slice(i * 4, i * 4 + 4), 16),
				)
			: []
		const info = await get(PID.DEVICE_INFO)
		for (const pid of [
			PID.DEVICE_MODEL_DESCRIPTION,
			PID.MANUFACTURER_LABEL,
			PID.DEVICE_LABEL,
			PID.SOFTWARE_VERSION_LABEL,
			PID.DMX_PERSONALITY,
			PID.DMX_START_ADDRESS,
			PID.SLOT_INFO,
			PID.DEVICE_HOURS,
			PID.LAMP_HOURS,
			PID.LAMP_STRIKES,
		]) {
			await get(pid)
		}
		for (const pid of supportedPids.filter((p) => p >= 0x8000)) {
			await get(PID.PARAMETER_DESCRIPTION, Buffer.from([pid >> 8, pid & 0xff]))
			await get(pid)
		}
		if (info && info.data.length >= 38) {
			const personalities = parseInt(info.data.slice(26, 28), 16)
			const footprint = parseInt(info.data.slice(20, 24), 16)
			for (let p = 1; p <= personalities; p++) await get(PID.DMX_PERSONALITY_DESCRIPTION, Buffer.from([p]))
			for (let slot = 0; slot < footprint; slot++) {
				await get(PID.SLOT_DESCRIPTION, Buffer.from([slot >> 8, slot & 0xff]))
			}
		}
	}
	return result
}

async function httpCapture(ip, method, urlPath, { body, headers } = {}) {
	try {
		const res = await fetch(`http://${ip}${urlPath}`, {
			method,
			headers: body === undefined ? headers : { 'Content-Type': 'application/json; charset=utf-8', ...headers },
			body: body === undefined ? undefined : JSON.stringify(body),
			signal: AbortSignal.timeout(3000),
		})
		const text = await res.text()
		const contentType = res.headers.get('content-type')
		const isHtml = contentType?.includes('html') && text.trimStart().startsWith('<')
		return {
			method,
			path: urlPath,
			requestBody: body ?? null,
			status: res.status,
			contentType,
			// Web pages are large and not parsed by the module, so only their title is kept
			body: isHtml ? null : text,
			htmlTitle: isHtml ? (/<title>([^<]*)<\/title>/i.exec(text)?.[1] ?? null) : null,
			htmlLength: isHtml ? text.length : null,
		}
	} catch (e) {
		return { method, path: urlPath, requestBody: body ?? null, error: e instanceof Error ? e.message : String(e) }
	}
}

async function captureHttp(ip) {
	const requests = [
		httpCapture(ip, 'GET', '/'),
		httpCapture(ip, 'POST', '/artnet_cfg_load', { body: { port: 0 } }),
		httpCapture(ip, 'GET', '/artnet_cfg_load'),
		httpCapture(ip, 'GET', '/api/session'),
		httpCapture(ip, 'GET', '/api/config'),
		httpCapture(ip, 'GET', '/api/snapshot'),
	]
	const captured = []
	for (const request of requests) captured.push(await request)

	const password = process.env.LYRA_PASSWORD
	const hasApi = captured.some((c) => c.path === '/api/session' && c.status === 200)
	if (password && hasApi) {
		const res = await fetch(`http://${ip}/api/login`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ password }),
			signal: AbortSignal.timeout(3000),
		}).catch(() => null)
		const login = res ? await res.json().catch(() => null) : null
		captured.push({
			method: 'POST',
			path: '/api/login',
			requestBody: { password: '<redacted>' },
			status: res?.status ?? null,
			body: login ? JSON.stringify({ ...login, token: login.token ? '<redacted>' : undefined }) : null,
		})
		if (login?.token) {
			for (const urlPath of ['/api/session', '/api/config', '/api/snapshot']) {
				const entry = await httpCapture(ip, 'GET', urlPath, { headers: { 'X-Auth-Token': login.token } })
				captured.push({ ...entry, authenticated: true })
			}
		}
	}
	return captured
}

const slug = (text) =>
	text
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-|-$/g, '')

const socket = new Socket()
await socket.open()
const nodes = await pollNodes(socket)
console.log(`Found ${nodes.length} node(s)`)
await fs.mkdir(OUT_DIR, { recursive: true })

for (const node of nodes) {
	const decoded = decodePollReply(node.pollReply)
	console.log(`Capturing ${decoded.longName} (${decoded.shortName}) at ${node.ip}`)
	const capture = {
		capturedAt: new Date().toISOString(),
		ip: node.ip,
		artnet: {
			pollRequest: hex(artPoll()),
			pollReply: hex(node.pollReply),
			pollReplySourcePort: node.sourcePort,
			decoded,
		},
		rdm: await captureRdm(socket, node.ip, decoded.portAddress),
		http: await captureHttp(node.ip),
	}
	const file = path.join(OUT_DIR, `${slug(decoded.shortName)}--${slug(decoded.longName)}.json`)
	await fs.writeFile(file, JSON.stringify(capture, null, '\t') + '\n')
	console.log(`  RDM: ${capture.rdm.uids.length ? `${capture.rdm.gets.length} GETs` : 'no answer'} → ${file}`)
}
socket.close()
