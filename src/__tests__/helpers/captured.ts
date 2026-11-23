import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { vi } from 'vitest'
import {
	DEFAULT_FIXTURE_STATE,
	getFixtureProfile,
	UNKNOWN_FIXTURE_PROFILE,
	type DiscoveredFixture,
	type DiscoveryOptions,
	type DiscoverySocket,
} from '../../api/index.js'
import type { ManagedFixture } from '../../fixtureManager.js'

/** A fixture as recorded by scripts/capture-fixtures.mjs */
export interface Capture {
	ip: string
	artnet: {
		pollReply: string
		decoded: { shortName: string; longName: string; portAddress: number; sacnOutput: boolean; mac: string }
	}
	rdm: {
		todRequest: string
		todData: string | null
		uids: string[]
		gets: { uid: string; pid: string; param: string; request: string; response: string | null }[]
	}
	http: {
		method: string
		path: string
		status?: number | null
		contentType?: string | null
		body?: string | null
		authenticated?: boolean
		error?: string
	}[]
}

const DIR = path.join(import.meta.dirname, '..', 'fixtures', 'captured')
const load = (name: string): Capture => JSON.parse(readFileSync(path.join(DIR, `${name}.json`), 'utf8')) as Capture

/** Newer "Ikan Lyra-PoE" firmware: answers RDM, web API behind a password */
export const lcx5 = load('ikan-lyra-poe--lcx5-poe')
/** Older "Eth2DMX-512-B" firmware: no RDM, config over HTTP */
export const lcx10 = load('eth2dmx-512-b--lcx10-poe-backlight')
export const lbx8 = load('eth2dmx-512-b--backlight-1-lbx8')
export const allCaptures = [lcx5, lcx10, lbx8]

/** A copy of a capture, for changing one detail */
export const cloneCapture = (capture: Capture): Capture => structuredClone(capture)

/** Set bits in one byte of the captured ArtPollReply */
export function withPollReplyBits(capture: Capture, offset: number, bits: number): Capture {
	const copy = cloneCapture(capture)
	const reply = Buffer.from(copy.artnet.pollReply, 'hex')
	reply[offset] |= bits
	copy.artnet.pollReply = reply.toString('hex')
	return copy
}

export const RDM_PID: Record<string, number> = { DMX_START_ADDRESS: 0x00f0, DEVICE_INFO: 0x0060 }

/** Parameter data of a captured RDM GET response */
export function rdmData(capture: Capture, pid: string): Buffer {
	const get = capture.rdm.gets.find((g) => g.pid === pid && g.param === '')
	if (!get?.response) throw new Error(`${capture.ip} has no ${pid} response`)
	const rdm = Buffer.from(get.response, 'hex').subarray(24)
	return rdm.subarray(23, 23 + rdm[22])
}

const opCode = (msg: Buffer) => msg.readUInt16LE(8)
const isBroadcast = (address: string) => address.endsWith('.255')

/**
 * Stands in for the network: replays what each captured fixture sent. A fixture only answers RDM on its own
 * port-address, as the real ones do.
 */
export class FakeNetwork {
	readonly sent: { packet: Buffer; address: string }[] = []
	readonly #captures: Capture[]

	constructor(captures: Capture[]) {
		this.#captures = captures
	}

	readonly createSocket = (): DiscoverySocket => new FakeSocket(this)

	readonly fetch = vi.fn(async (input: string | URL, init?: RequestInit): Promise<Response> => {
		const url = new URL(input)
		const method = init?.method ?? 'GET'
		const capture = this.#captures.find((c) => c.ip === url.hostname)
		const entry = capture?.http.find((h) => h.method === method && h.path === url.pathname && !h.authenticated)
		if (!entry || entry.status == null) throw new TypeError('fetch failed')
		return new Response(entry.body ?? '', {
			status: entry.status,
			headers: entry.contentType ? { 'Content-Type': entry.contentType } : {},
		})
	})

	/** Packets of one Art-Net op code sent to an address */
	sentTo(address: string, op: number): Buffer[] {
		return this.sent.filter((s) => s.address === address && opCode(s.packet) === op).map((s) => s.packet)
	}

	replies(msg: Buffer, address: string): { from: string; reply: Buffer }[] {
		const op = opCode(msg)
		if (op === 0x2000) {
			return this.#captures
				.filter((c) => isBroadcast(address) || c.ip === address)
				.map((c) => ({ from: c.ip, reply: Buffer.from(c.artnet.pollReply, 'hex') }))
		}
		const capture = this.#captures.find((c) => c.ip === address)
		if (!capture) return []
		const portAddress = capture.artnet.decoded.portAddress
		const addressed = ((msg[21] & 0x7f) << 8) | msg[op === 0x8000 ? 24 : 23]
		if (addressed !== portAddress) return []
		if (op === 0x8000 && capture.rdm.todData) {
			return [{ from: capture.ip, reply: Buffer.from(capture.rdm.todData, 'hex') }]
		}
		if (op === 0x8300) {
			const pid = msg.readUInt16BE(44)
			const get = capture.rdm.gets.find(
				(g) => g.param === '' && g.response && Buffer.from(g.request, 'hex').readUInt16BE(44) === pid,
			)
			if (get?.response) return [{ from: capture.ip, reply: Buffer.from(get.response, 'hex') }]
		}
		return []
	}
}

class FakeSocket extends EventEmitter implements DiscoverySocket {
	#closed = false
	readonly #network: FakeNetwork

	constructor(network: FakeNetwork) {
		super()
		this.#network = network
	}

	bind(_port: number, _address: string | undefined, callback: () => void): void {
		setImmediate(callback)
	}

	setBroadcast(): void {}

	send(msg: Buffer, _port: number, address: string, callback: (error: Error | null) => void): void {
		this.#network.sent.push({ packet: Buffer.from(msg), address })
		callback(null)
		for (const { from, reply } of this.#network.replies(msg, address)) {
			setImmediate(() => {
				if (!this.#closed) this.emit('message', reply, { address: from, port: 6454 })
			})
		}
	}

	close(): void {
		this.#closed = true
	}
}

/** Discovery options that run quickly against a FakeNetwork */
export function fakeDiscoveryOptions(network: FakeNetwork): DiscoveryOptions {
	return {
		createSocket: network.createSocket,
		timeoutMs: 100,
		pollCount: 1,
		targets: ['255.255.255.255'],
		adapters: [],
		rdmTimeoutMs: 150,
		httpTimeoutMs: 500,
		log: () => {},
	}
}

/** The fixture the module would manage for a discovered node */
export function managedFixture(node: DiscoveredFixture): ManagedFixture {
	if (!node.dmx) throw new Error(`${node.ip} has no DMX config`)
	return {
		id: node.mac.replace(/:/g, ''),
		ip: node.ip,
		name: node.longName,
		profile: getFixtureProfile(node.longName) ?? UNKNOWN_FIXTURE_PROFILE,
		dmx: node.dmx,
		protocol: node.dmx.protocol,
		state: { ...DEFAULT_FIXTURE_STATE },
		online: true,
	}
}
