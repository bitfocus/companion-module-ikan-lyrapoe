import { afterEach, describe, expect, it, vi } from 'vitest'
import {
	discoverFixtures,
	fetchFixtureDmxConfig,
	fetchRdmDmxAddress,
	getFixtureProfile,
	type DiscoveredFixture,
} from '../api/index.js'
import {
	cloneCapture,
	FakeNetwork,
	fakeDiscoveryOptions,
	lbx8,
	lcx10,
	lcx5,
	rdmData,
	withPollReplyBits,
	type Capture,
} from './helpers/captured.js'

const OP_TOD_REQUEST = 0x8000
const OP_RDM = 0x8300

async function discover(captures: Capture[]): Promise<{ network: FakeNetwork; found: DiscoveredFixture[] }> {
	const network = new FakeNetwork(captures)
	vi.stubGlobal('fetch', network.fetch)
	const found = await discoverFixtures(fakeDiscoveryOptions(network))
	found.sort((a, b) => a.ip.localeCompare(b.ip, undefined, { numeric: true }))
	return { network, found }
}

const fetchedHosts = (network: FakeNetwork) => network.fetch.mock.calls.map(([input]) => new URL(input).hostname)

afterEach(() => {
	vi.unstubAllGlobals()
})

describe('discoverFixtures', () => {
	it('finds every captured fixture with its DMX config', async () => {
		const { found } = await discover([lcx5, lcx10, lbx8])
		expect(found).toEqual([
			{
				ip: '192.168.0.15',
				mac: '84:1f:e8:0d:fa:77',
				longName: 'Backlight 1 (LBX8)',
				portAddress: 0,
				sacnOutput: false,
				dmx: { dmxAddress: 34, protocol: 'artnet', artnetUniverse: 0, sacnUniverse: 1 },
			},
			{
				ip: '192.168.0.112',
				mac: '5c:01:3b:3a:05:a8',
				longName: 'LCX5-POE',
				portAddress: 6,
				sacnOutput: false,
				dmx: { dmxAddress: 5, protocol: 'artnet', artnetUniverse: 6, sacnUniverse: 1 },
			},
			{
				ip: '192.168.0.180',
				mac: '80:f3:da:55:e9:fb',
				longName: 'LCX10-POE Backlight',
				portAddress: 0,
				sacnOutput: false,
				dmx: { dmxAddress: 1, protocol: 'artnet', artnetUniverse: 0, sacnUniverse: 1 },
			},
		])
	})

	it('reads the Lyra-PoE firmware over RDM without touching its web API', async () => {
		const { network } = await discover([lcx5])
		expect(fetchedHosts(network)).not.toContain(lcx5.ip)
	})

	it("asks for the RDM device list on the fixture's own port-address", async () => {
		const { network } = await discover([lcx5])
		const [request] = network.sentTo(lcx5.ip, OP_TOD_REQUEST)
		expect(request?.toString('hex')).toBe(lcx5.rdm.todRequest)
	})

	it('reads DMX_START_ADDRESS from the device the fixture lists', async () => {
		const { network } = await discover([lcx5])
		const [request] = network.sentTo(lcx5.ip, OP_RDM)
		const captured = Buffer.from(lcx5.rdm.gets.find((g) => g.pid === 'DMX_START_ADDRESS')!.request, 'hex')
		// The transaction number and so the checksum differ between the module and the capture script
		const comparable = (packet: Buffer) => Buffer.concat([packet.subarray(0, 38), packet.subarray(39, -2)])
		expect(request && comparable(request)).toEqual(comparable(captured))
		expect(request?.subarray(26, 32).toString('hex')).toBe(lcx5.rdm.uids[0])
	})

	it('takes sACN from the GoodOutputA flag of the poll reply, as RDM has no protocol', async () => {
		const { found } = await discover([withPollReplyBits(lcx5, 182, 0x01)])
		expect(found[0]?.sacnOutput).toBe(true)
		expect(found[0]?.dmx).toEqual({ dmxAddress: 5, protocol: 'sacn', artnetUniverse: 6, sacnUniverse: 1 })
	})

	it('falls back to /artnet_cfg_load for firmware that ignores RDM', async () => {
		const { network } = await discover([lcx10])
		expect(network.sentTo(lcx10.ip, OP_TOD_REQUEST).length).toBeGreaterThan(0)
		expect(network.fetch).toHaveBeenCalledWith(
			`http://${lcx10.ip}/artnet_cfg_load`,
			expect.objectContaining({ method: 'POST', body: JSON.stringify({ port: 0 }) }),
		)
	})

	it('reports no DMX config when neither RDM nor the old web API answers', async () => {
		const silent = cloneCapture(lcx5)
		silent.rdm.todData = null
		const { found } = await discover([silent])
		expect(found).toMatchObject([{ ip: lcx5.ip, longName: 'LCX5-POE', dmx: null }])
	})
})

describe('fetchRdmDmxAddress', () => {
	it('reads the start address the fixture reports', async () => {
		const network = new FakeNetwork([lcx5])
		await expect(fetchRdmDmxAddress(lcx5.ip, 6, network.createSocket, 500)).resolves.toBe(
			rdmData(lcx5, 'DMX_START_ADDRESS').readUInt16BE(0),
		)
	})

	it('gives up when asked on another port-address, which the fixture ignores', async () => {
		const network = new FakeNetwork([lcx5])
		await expect(fetchRdmDmxAddress(lcx5.ip, 0, network.createSocket, 150)).resolves.toBeNull()
	})

	it('gives up on firmware without RDM', async () => {
		const network = new FakeNetwork([lcx10])
		await expect(fetchRdmDmxAddress(lcx10.ip, 0, network.createSocket, 150)).resolves.toBeNull()
	})
})

describe('fetchFixtureDmxConfig', () => {
	it('parses the old firmware config, which sends numbers as strings', async () => {
		vi.stubGlobal('fetch', new FakeNetwork([lbx8]).fetch)
		await expect(fetchFixtureDmxConfig(lbx8.ip, 500)).resolves.toEqual({
			dmxAddress: 34,
			protocol: 'artnet',
			artnetUniverse: 0,
			sacnUniverse: 1,
		})
	})

	it('rejects on the Lyra-PoE firmware, which no longer has the endpoint', async () => {
		vi.stubGlobal('fetch', new FakeNetwork([lcx5]).fetch)
		await expect(fetchFixtureDmxConfig(lcx5.ip, 500)).rejects.toThrow('HTTP 404')
	})
})

describe('fixture profiles', () => {
	it.each([
		['LCX5-POE', 'LCX5'],
		['LCX10-POE Backlight', 'LCX10'],
		['Backlight 1 (LBX8)', 'LBX8'],
	])('recognises "%s" as %s', (name, model) => {
		expect(getFixtureProfile(name)?.model).toBe(model)
	})

	it('has the footprint the LCX5 reports over RDM', () => {
		const footprint = rdmData(lcx5, 'DEVICE_INFO').readUInt16BE(10)
		expect(getFixtureProfile(lcx5.artnet.decoded.longName)?.channels).toBe(footprint)
	})
})
