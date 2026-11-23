import { InstanceStatus } from '@companion-module/base'
import type { ManagedFixture } from './fixtureManager.js'

const fixtureCount = (count: number) => `${count} fixture${count === 1 ? '' : 's'}`

/**
 * The connection is OK while any fixture answers: one light being off or removed doesn't stop the others
 * working, and each fixture's own online feedback and variable show which ones are missing.
 */
export function connectionStatus(fixtures: ManagedFixture[]): { status: InstanceStatus; message: string } {
	const online = fixtures.filter((f) => f.online).length
	const offline = fixtures.length - online
	if (fixtures.length === 0) return { status: InstanceStatus.Disconnected, message: 'No fixtures found' }
	if (online === 0) return { status: InstanceStatus.Disconnected, message: `${fixtureCount(offline)} offline` }
	return {
		status: InstanceStatus.Ok,
		message: offline > 0 ? `${fixtureCount(online)} (${offline} offline)` : fixtureCount(online),
	}
}
