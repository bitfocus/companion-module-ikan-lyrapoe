import { describe, expect, it } from 'vitest'
import { DEFAULT_FIXTURE_STATE, getFixtureProfile } from '../api/index.js'
import type { ManagedFixture } from '../fixtureManager.js'
import { captureLightPreset, isLightPresetActive } from '../lightPresets.js'

function fixture(id: string, online: boolean): ManagedFixture {
	return {
		id,
		ip: '192.168.0.1',
		name: 'LCX5-POE',
		profile: getFixtureProfile('LCX5-POE')!,
		dmx: { dmxAddress: 1, protocol: 'artnet', artnetUniverse: 0, sacnUniverse: 1 },
		protocol: 'artnet',
		state: { ...DEFAULT_FIXTURE_STATE, intensity: 50 },
		online,
	}
}

const managerOf = (known: ManagedFixture[]) => ({ getFixture: (id: string) => known.find((f) => f.id === id) })

describe('isLightPresetActive', () => {
	const a = fixture('a', true)
	const b = fixture('b', true)
	const preset = captureLightPreset([a, b])

	it('is active while every fixture still matches', () => {
		expect(isLightPresetActive(preset, managerOf([a, b]))).toBe(true)
	})

	it('is not active while one of its fixtures is offline', () => {
		expect(isLightPresetActive(preset, managerOf([a, { ...b, online: false }]))).toBe(false)
	})

	it('leaves out a fixture that has been forgotten', () => {
		expect(isLightPresetActive(preset, managerOf([a]))).toBe(true)
	})

	it('is not active when none of its fixtures are known', () => {
		expect(isLightPresetActive(preset, managerOf([]))).toBe(false)
	})

	it('is not active once a fixture has changed', () => {
		expect(isLightPresetActive(preset, managerOf([a, { ...b, state: { ...b.state, intensity: 10 } }]))).toBe(false)
	})
})
