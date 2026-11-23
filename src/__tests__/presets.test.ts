import type {
	CompanionLayeredButtonPresetDefinition,
	CompanionPresetDefinitions,
	CompanionPresetGroupSimple,
	CompanionPresetSection,
	CompanionSimplePresetDefinition,
	CompanionVariableDefinitions,
	SomeButtonGraphicsElement,
} from '@companion-module/base'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { discoverFixtures } from '../api/index.js'
import type { ManagedFixture } from '../fixtureManager.js'
import type IkanInstance from '../main.js'
import { UpdatePresets } from '../presets.js'
import type { ValueScale } from '../valueScale.js'
import { UpdateVariableDefinitions } from '../variables.js'
import { allCaptures, FakeNetwork, fakeDiscoveryOptions, lbx8, lcx5, managedFixture } from './helpers/captured.js'

type Variants = { layered: CompanionLayeredButtonPresetDefinition; simple: CompanionSimplePresetDefinition }

interface Built {
	structure: CompanionPresetSection[]
	presets: CompanionPresetDefinitions
	variables: string[]
}

let fixtures: ManagedFixture[] = []

beforeAll(async () => {
	const network = new FakeNetwork(allCaptures)
	vi.stubGlobal('fetch', network.fetch)
	// In the order FixtureManager lists them
	fixtures = (await discoverFixtures(fakeDiscoveryOptions(network)))
		.map(managedFixture)
		.sort((a, b) => a.dmx.dmxAddress - b.dmx.dmxAddress)
})

afterAll(() => {
	vi.unstubAllGlobals()
})

function build(valueScale: ValueScale): Built {
	const built: Built = { structure: [], presets: {}, variables: [] }
	const instance = {
		config: { valueScale },
		fixtures: { fixtures },
		setPresetDefinitions: (structure: CompanionPresetSection[], presets: CompanionPresetDefinitions) => {
			built.structure = structure
			built.presets = presets
		},
		setVariableDefinitions: (definitions: CompanionVariableDefinitions) => {
			built.variables = Object.keys(definitions)
		},
	} as unknown as IkanInstance
	UpdatePresets(instance)
	UpdateVariableDefinitions(instance)
	return built
}

function variantsOf(built: Built, id: string): Variants {
	const preset = built.presets[id]
	if (preset?.type !== 'alternatives') throw new Error(`${id} has no alternatives`)
	const [layered, simple] = preset.variants
	if (layered?.type !== 'layered' || simple?.type !== 'simple') throw new Error(`${id} is not layered, then simple`)
	return { layered, simple }
}

const everything = (built: Built) => Object.keys(built.presets).map((id) => [id, variantsOf(built, id)] as const)

const elementsOf = (layered: CompanionLayeredButtonPresetDefinition) => layered.elements as SomeButtonGraphicsElement[]
const element = (layered: CompanionLayeredButtonPresetDefinition, id: string) =>
	elementsOf(layered).find((e) => e.id === id)

/** Every string anywhere in a value */
function stringsOf(value: unknown): string[] {
	if (typeof value === 'string') return [value]
	if (Array.isArray(value)) return value.flatMap(stringsOf)
	if (typeof value === 'object' && value !== null) return Object.values(value).flatMap(stringsOf)
	return []
}

describe('presets', () => {
	let built: Built
	beforeAll(() => {
		built = build('percent')
	})

	it('has a section for all fixtures, then light presets, then one per fixture', () => {
		expect(built.structure.map((s) => s.name)).toEqual([
			'All Fixtures',
			'Presets',
			'LCX10-POE Backlight (DMX 1)',
			'LCX5-POE (DMX 5)',
			'Backlight 1 (LBX8) (DMX 34)',
		])
	})

	it('references every preset from the structure, and only presets that exist', () => {
		const referenced = built.structure.flatMap((s) =>
			(s.definitions as CompanionPresetGroupSimple[]).flatMap((g) => g.presets),
		)
		expect(new Set(referenced)).toEqual(new Set(Object.keys(built.presets)))
	})

	it('offers every preset as a layered button with a simple fallback', () => {
		for (const [id] of everything(built)) expect(() => variantsOf(built, id)).not.toThrow()
	})

	it('gives the fallback the same name, actions and feedbacks as the layered button', () => {
		for (const [, { layered, simple }] of everything(built)) {
			expect(simple.name).toBe(layered.name)
			expect(simple.steps).toEqual(layered.steps)
			expect(simple.keywords).toEqual(layered.keywords)
			const layeredIds = layered.feedbacks
				.filter((f) => 'feedbackId' in f && f.feedbackId !== 'fixture_online')
				.map((f) => ('feedbackId' in f ? f.feedbackId : null))
			expect(simple.feedbacks.map((f) => f.feedbackId)).toEqual(layeredIds)
		}
	})

	it('draws tiles as editable elements, not composites', () => {
		const problems = everything(built).flatMap(([id, { layered }]) => {
			const elements = elementsOf(layered)
			const ids = elements.map((e) => e.id)
			return [
				elements.length > 1 ? [] : [`${id} has a single element`],
				elements.some((e) => e.type === 'composite') ? [`${id} uses a composite`] : [],
				new Set(ids).size === ids.length ? [] : [`${id} repeats an element id`],
			].flat()
		})
		expect(problems).toEqual([])
	})

	it('only overrides elements that exist', () => {
		const missing = everything(built).flatMap(([id, { layered }]) =>
			layered.feedbacks.flatMap((feedback) =>
				'styleOverrides' in feedback
					? feedback.styleOverrides
							.filter((override) => !element(layered, override.elementId))
							.map((override) => `${id} overrides ${override.elementId}`)
					: [],
			),
		)
		expect(missing).toEqual([])
	})

	it('only reads variables the module defines', () => {
		const defined = new Set(built.variables)
		const unknown = everything(built).flatMap(([id, variants]) =>
			[
				...stringsOf(variants)
					.join('\n')
					.matchAll(/\$\(lyra:([^)]+)\)/g),
			]
				.filter((match) => !defined.has(match[1]))
				.map((match) => `${id} reads ${match[1]}`),
		)
		expect(unknown).toEqual([])
	})

	it("shades a fixture's tiles while it is offline, with one layer and its online feedback", () => {
		const id = lcx5.artnet.decoded.mac.replace(/:/g, '')
		const fixtureTiles = everything(built).filter(([presetId]) => presetId.startsWith(`${id}_`))
		expect(fixtureTiles.length).toBeGreaterThan(0)
		const shadeFeedback = expect.objectContaining({
			feedbackId: 'fixture_online',
			options: { target: 'select', fixtures: [id] },
			isInverted: true,
			styleOverrides: [{ elementId: 'offline', elementProperty: 'enabled', override: true }],
		})
		expect(
			fixtureTiles.map(([presetId, { layered }]) => ({
				presetId,
				shade: element(layered, 'offline'),
				feedbacks: layered.feedbacks,
				// The shade replaced an online expression on every element
				onlineExpressions: elementsOf(layered).filter((e) => JSON.stringify(e).includes('_online')),
			})),
		).toEqual(
			fixtureTiles.map(([presetId]) => ({
				presetId,
				shade: expect.objectContaining({ type: 'box', enabled: false }),
				feedbacks: expect.arrayContaining([shadeFeedback]),
				onlineExpressions: [],
			})),
		)
	})

	it('does not shade tiles that are not for one fixture', () => {
		const shaded = everything(built)
			.filter(([presetId]) => presetId.startsWith('all_') || presetId.startsWith('light_preset_'))
			.filter(
				([, { layered }]) =>
					element(layered, 'offline') ||
					layered.feedbacks.some((f) => 'feedbackId' in f && f.feedbackId === 'fixture_online'),
			)
			.map(([presetId]) => presetId)
		expect(shaded).toEqual([])
	})

	it('only offers color controls a fixture supports', () => {
		const lbx8Id = lbx8.artnet.decoded.mac.replace(/:/g, '')
		const lcx5Id = lcx5.artnet.decoded.mac.replace(/:/g, '')
		const ids = Object.keys(built.presets)
		expect(ids.filter((id) => id.startsWith(`${lbx8Id}_`) && /_(hsi|rgb|mode)_/.test(id))).toEqual([])
		expect(ids).toContain(`${lcx5Id}_hsi_red`)
		expect(ids).toContain(`${lcx5Id}_mode_rgb`)
	})

	it("sizes the Kelvin ring to the fixture's range", () => {
		const lcx5Id = lcx5.artnet.decoded.mac.replace(/:/g, '')
		const { layered } = variantsOf(built, `${lcx5Id}_cct_rotary`)
		expect(element(layered, 'ring')).toMatchObject({ type: 'gauge', min: 2700, max: 5600 })
	})
})

describe('presets in the DMX value scale', () => {
	it('sizes the intensity ring to 0-255', () => {
		const built = build('dmx')
		const lcx5Id = lcx5.artnet.decoded.mac.replace(/:/g, '')
		const { layered } = variantsOf(built, `${lcx5Id}_rotary`)
		expect(element(layered, 'ring')).toMatchObject({ type: 'gauge', min: 0, max: 255 })
		expect(element(layered, 'value')).toMatchObject({ text: `$(lyra:${lcx5Id}_intensity)` })
	})
})
