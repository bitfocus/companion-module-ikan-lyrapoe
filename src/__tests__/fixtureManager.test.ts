import { afterEach, describe, expect, it, vi } from 'vitest'
import { FixtureManager } from '../fixtureManager.js'
import { allCaptures, FakeNetwork, lbx8, lcx10, lcx5, type Capture } from './helpers/captured.js'

const transports = vi.hoisted(() => [] as { host: string; stop: () => void }[])

// Keep DMX off the real network: the captured fixtures' IPs are real lights
vi.mock('../api/index.js', async (importOriginal) => ({
	...(await importOriginal<typeof import('../api/index.js')>()),
	createTransport: (_protocol: string, host: string) => {
		const transport = { host, start: vi.fn(async () => {}), stop: vi.fn(), setSlots: vi.fn() }
		transports.push(transport)
		return transport
	},
}))

/** A manager on a network whose fixtures can be changed between polls */
function setup(initial: Capture[]) {
	let network = new FakeNetwork(initial)
	const onFixturesChanged = vi.fn()
	const manager = new FixtureManager({
		createSocket: () => network.createSocket(),
		log: () => {},
		onFixturesChanged,
	})
	const poll = async (captures: Capture[]) => {
		network = new FakeNetwork(captures)
		vi.stubGlobal('fetch', network.fetch)
		return manager.discover(['255.255.255.255'], 100)
	}
	return { manager, poll, onFixturesChanged }
}

const idOf = (capture: Capture) => capture.artnet.decoded.mac.replace(/:/g, '')

afterEach(() => {
	vi.unstubAllGlobals()
	transports.length = 0
})

describe('FixtureManager', () => {
	it('keeps a fixture that stops answering, as offline', async () => {
		const { manager, poll } = setup(allCaptures)
		await poll(allCaptures)
		await poll([lcx5, lcx10])
		expect(manager.fixtures.map((f) => [f.name, f.online])).toEqual([
			['LCX10-POE Backlight', true],
			['LCX5-POE', true],
			['Backlight 1 (LBX8)', false],
		])
	})

	it('forgets offline fixtures and stops sending to them', async () => {
		const { manager, poll, onFixturesChanged } = setup(allCaptures)
		await poll(allCaptures)
		// Sending state opens a transport per fixture, which keeps resending until stopped
		manager.updateState(manager.fixtures, { intensity: 50 })
		await poll([lcx5, lcx10])
		onFixturesChanged.mockClear()

		const forgotten = manager.forgetOffline()

		expect(forgotten.map((f) => f.id)).toEqual([idOf(lbx8)])
		expect(manager.fixtures.map((f) => f.id)).toEqual([idOf(lcx10), idOf(lcx5)])
		expect(manager.getFixture(idOf(lbx8))).toBeUndefined()
		expect(onFixturesChanged).toHaveBeenCalledOnce()
		const lbx8Transports = transports.filter((t) => t.host === lbx8.ip)
		expect(lbx8Transports.length).toBeGreaterThan(0)
		for (const transport of lbx8Transports) expect(transport.stop).toHaveBeenCalled()
	})

	it('does nothing when every fixture is online', async () => {
		const { manager, poll, onFixturesChanged } = setup(allCaptures)
		await poll(allCaptures)
		onFixturesChanged.mockClear()

		expect(manager.forgetOffline()).toEqual([])
		expect(manager.fixtures).toHaveLength(3)
		expect(onFixturesChanged).not.toHaveBeenCalled()
	})

	it('finds a forgotten fixture again, under the same id, when it comes back', async () => {
		const { manager, poll } = setup(allCaptures)
		await poll(allCaptures)
		await poll([lcx5, lcx10])
		manager.forgetOffline()

		await poll(allCaptures)

		expect(manager.getFixture(idOf(lbx8))).toMatchObject({ name: 'Backlight 1 (LBX8)', online: true })
	})
})
