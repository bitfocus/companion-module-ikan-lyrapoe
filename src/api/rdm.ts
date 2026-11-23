import { ARTNET_ID, ARTNET_PORT, ARTNET_PROTOCOL_VERSION } from './artnet.js'
import type { DiscoverySocket } from './discovery.js'

const OP_TOD_REQUEST = 0x8000
const OP_TOD_DATA = 0x8100
const OP_RDM = 0x8300

const RDM_START_CODE = 0xcc
const RDM_SUB_START_CODE = 0x01
const RDM_GET_COMMAND = 0x20
const RDM_GET_COMMAND_RESPONSE = 0x21
const RDM_RESPONSE_ACK = 0x00
const PID_DMX_START_ADDRESS = 0x00f0

/** ESTA's prototyping manufacturer id, for a controller that has no registered one */
const CONTROLLER_UID = Buffer.from([0x7f, 0xf0, 0x00, 0x00, 0x00, 0x01])

/** Requests are resent at this interval until answered, as UDP replies are occasionally dropped */
const RESEND_INTERVAL_MS = 250

function artNetHeader(opCode: number): Buffer {
	const header = Buffer.alloc(12)
	ARTNET_ID.copy(header, 0)
	header.writeUInt16LE(opCode, 8)
	header.writeUInt16BE(ARTNET_PROTOCOL_VERSION, 10)
	return header
}

function buildTodRequest(portAddress: number): Buffer {
	// Filler (2), Spare (7), Net, Command (0 = TodFull), AdCount, Address[32]
	const body = Buffer.alloc(9 + 3 + 32)
	body[9] = (portAddress >> 8) & 0x7f
	body[11] = 1
	body[12] = portAddress & 0xff
	return Buffer.concat([artNetHeader(OP_TOD_REQUEST), body])
}

/** The first UID in an ArtTodData for this port-address, or null if it lists none */
function parseTodData(msg: Buffer, portAddress: number): Buffer | null {
	if (msg.length < 28 || msg.readUInt16LE(8) !== OP_TOD_DATA) return null
	// RdmVer, Port, Spare (6), BindIndex, Net, CommandResponse, Address, UidTotal (2), BlockCount, UidCount
	if ((msg[21] & 0x7f) !== portAddress >> 8 || msg[23] !== (portAddress & 0xff)) return null
	if (msg[27] === 0 || msg.length < 34) return null
	return msg.subarray(28, 34)
}

function buildRdmGet(portAddress: number, uid: Buffer, transaction: number, pid: number): Buffer {
	const rdm = Buffer.concat([
		Buffer.from([RDM_START_CODE, RDM_SUB_START_CODE, 24]),
		uid,
		CONTROLLER_UID,
		// Transaction, port id, message count, sub-device (2), command class, PID (2), PDL
		Buffer.from([transaction & 0xff, 1, 0, 0, 0, RDM_GET_COMMAND, pid >> 8, pid & 0xff, 0]),
	])
	const checksum = rdm.reduce((sum, byte) => sum + byte, 0) & 0xffff
	// RdmVer (1 = RDM standard v1.0), Filler, Spare (7), Net, Command (0 = process), Address
	const header = Buffer.from([1, 0, 0, 0, 0, 0, 0, 0, 0, (portAddress >> 8) & 0x7f, 0, portAddress & 0xff])
	// ArtRdm carries the RDM packet without its start code
	return Buffer.concat([artNetHeader(OP_RDM), header, rdm.subarray(1), Buffer.from([checksum >> 8, checksum & 0xff])])
}

/** The parameter data of an ArtRdm ACK from `uid` answering a GET of `pid`, or null */
function parseRdmGetResponse(msg: Buffer, uid: Buffer, pid: number): Buffer | null {
	if (msg.length < 24 + 23 || msg.readUInt16LE(8) !== OP_RDM) return null
	const rdm = msg.subarray(24)
	if (rdm[0] !== RDM_SUB_START_CODE || !rdm.subarray(8, 14).equals(uid)) return null
	if (rdm[15] !== RDM_RESPONSE_ACK || rdm[19] !== RDM_GET_COMMAND_RESPONSE || rdm.readUInt16BE(20) !== pid) return null
	const length = rdm[22]
	if (rdm.length < 23 + length) return null
	return rdm.subarray(23, 23 + length)
}

/**
 * Read a fixture's DMX start address over RDM, tunnelled through Art-Net. The fixture only answers on
 * its own port-address, so that must come from its ArtPollReply. Resolves to null if it doesn't answer.
 */
export async function fetchRdmDmxAddress(
	ip: string,
	portAddress: number,
	createSocket: () => DiscoverySocket,
	timeoutMs: number,
): Promise<number | null> {
	const socket = createSocket()
	let resendTimer: NodeJS.Timeout | undefined
	let timeoutTimer: NodeJS.Timeout | undefined
	try {
		return await new Promise<number | null>((resolve, reject) => {
			let uid: Buffer | null = null
			let request = buildTodRequest(portAddress)
			const send = () => socket.send(request, ARTNET_PORT, ip, () => {})

			socket.on('error', reject)
			socket.on('message', (msg: Buffer, rinfo: { address: string }) => {
				if (rinfo.address !== ip || !msg.subarray(0, 8).equals(ARTNET_ID)) return
				if (!uid) {
					uid = parseTodData(msg, portAddress)
					if (!uid) return
					request = buildRdmGet(portAddress, uid, 0, PID_DMX_START_ADDRESS)
					send()
					return
				}
				const data = parseRdmGetResponse(msg, uid, PID_DMX_START_ADDRESS)
				if (data && data.length >= 2) resolve(data.readUInt16BE(0))
			})
			timeoutTimer = setTimeout(() => resolve(null), timeoutMs)
			socket.bind(0, undefined, () => {
				send()
				resendTimer = setInterval(send, RESEND_INTERVAL_MS)
			})
		})
	} finally {
		clearInterval(resendTimer)
		clearTimeout(timeoutTimer)
		socket.close()
	}
}
