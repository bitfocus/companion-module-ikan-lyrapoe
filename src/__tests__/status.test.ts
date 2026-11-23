import { InstanceStatus } from '@companion-module/base'
import { describe, expect, it } from 'vitest'
import type { ManagedFixture } from '../fixtureManager.js'
import { connectionStatus } from '../status.js'

const fixtures = (...online: boolean[]) => online.map((isOnline) => ({ online: isOnline }) as ManagedFixture)

describe('connectionStatus', () => {
	it('is disconnected before any fixture is found', () => {
		expect(connectionStatus([])).toEqual({ status: InstanceStatus.Disconnected, message: 'No fixtures found' })
	})

	it('is OK while every fixture answers', () => {
		expect(connectionStatus(fixtures(true, true, true))).toEqual({ status: InstanceStatus.Ok, message: '3 fixtures' })
		expect(connectionStatus(fixtures(true))).toEqual({ status: InstanceStatus.Ok, message: '1 fixture' })
	})

	it('stays OK when some fixtures are offline, and says how many', () => {
		expect(connectionStatus(fixtures(true, false, true))).toEqual({
			status: InstanceStatus.Ok,
			message: '2 fixtures (1 offline)',
		})
	})

	it('is disconnected when no fixture answers', () => {
		expect(connectionStatus(fixtures(false, false))).toEqual({
			status: InstanceStatus.Disconnected,
			message: '2 fixtures offline',
		})
	})
})
