import {
	combineRgb,
	type CompanionButtonStyleProps,
	type CompanionPresetAction,
	type CompanionPresetDefinitions,
	type CompanionPresetGroupSimple,
	type CompanionPresetSection,
} from '@companion-module/base'
import type { ActionsSchema, FixtureTargetOptions } from './actions.js'
import type { ManagedFixture } from './fixtureManager.js'
import type { ModuleSchema } from './main.js'
import type IkanInstance from './main.js'
import { COLOR_MODES } from './api/index.js'
import { LIGHT_PRESET_BUTTONS } from './lightPresets.js'
import { Colors, levelPreset, statusPreset, textOn, type LevelTile, type TileState } from './presetTiles.js'
import { fromState, levelRange, levelSuffix, type LevelParameter, type ValueScale } from './valueScale.js'

type PresetAction = CompanionPresetAction<ActionsSchema>

const WHITE = combineRgb(255, 255, 255)
const BLACK = combineRgb(0, 0, 0)
const GREY = combineRgb(40, 40, 40)

const CCT_PRESETS = [2700, 3200, 4300, 5600, 6500]

const GREEN_MAGENTA_PRESETS = [
	{ id: 'green', label: 'Green +50', text: 'G +50', value: -50, color: combineRgb(150, 255, 150) },
	{ id: 'neutral', label: 'Green/Magenta Neutral', text: 'G/M 0', value: 0, color: combineRgb(220, 220, 220) },
	{ id: 'magenta', label: 'Magenta +50', text: 'M +50', value: 50, color: combineRgb(255, 150, 255) },
]

const COLOR_PRESETS: { id: string; label: string; hue: number; saturation: number; rgb: [number, number, number] }[] = [
	{ id: 'red', label: 'Red', hue: 0, saturation: 100, rgb: [255, 0, 0] },
	{ id: 'orange', label: 'Orange', hue: 30, saturation: 100, rgb: [255, 128, 0] },
	{ id: 'yellow', label: 'Yellow', hue: 60, saturation: 100, rgb: [255, 255, 0] },
	{ id: 'green', label: 'Green', hue: 120, saturation: 100, rgb: [0, 255, 0] },
	{ id: 'cyan', label: 'Cyan', hue: 180, saturation: 100, rgb: [0, 255, 255] },
	{ id: 'blue', label: 'Blue', hue: 240, saturation: 100, rgb: [0, 0, 255] },
	{ id: 'magenta', label: 'Magenta', hue: 300, saturation: 100, rgb: [255, 0, 255] },
	{ id: 'white', label: 'White', hue: 0, saturation: 0, rgb: [255, 255, 255] },
]

/** Approximate button colour for a Kelvin value: warm amber at the low end, cool blue-white at the high end */
function kelvinColor(kelvin: number, min: number, max: number): number {
	const t = (kelvin - min) / (max - min)
	const lerp = (a: number, b: number) => Math.round(a + (b - a) * t)
	return combineRgb(lerp(255, 200), lerp(170, 220), lerp(80, 255))
}

/** Button style with black or white text, whichever reads better on the background */
function buttonStyle(text: string, bgcolor: number): CompanionButtonStyleProps {
	return { text, size: 'auto', show_topbar: false, color: textOn(bgcolor), bgcolor }
}

// Companion rewrites the connection label in $(...) references when a preset is placed
const v = (fixtureId: string, suffix: string) => `$(lyra:${fixtureId}_${suffix})`

type StatusLook = { title: string; status: string; accent: number }
type LevelLook = Omit<LevelTile, 'label' | 'fixtureId'>

/** Build one preset section, either for every fixture (fixture null) or for a single fixture */
function buildSection(
	presets: CompanionPresetDefinitions<ModuleSchema>,
	scale: ValueScale,
	sectionId: string,
	label: string,
	fixture: ManagedFixture | null,
): CompanionPresetSection {
	const selection: FixtureTargetOptions = fixture
		? { target: 'select', fixtures: [fixture.id] }
		: { target: 'all', fixtures: [] }
	const groups: CompanionPresetGroupSimple[] = []
	const group = (suffix: string, name: string, description: string, presetIds: string[]) => {
		groups.push({ id: `${sectionId}_${suffix}`, name, description, type: 'simple', presets: presetIds })
	}
	const line = (text: string) => `${label}\\n${text}`
	// Preset values are written in the user's chosen scale
	const level = (param: LevelParameter, stateValue: number) => Math.round(fromState(scale, param, stateValue))
	const intensitySuffix = levelSuffix(scale, 'intensity')
	const [intensityMin, intensityMax] = levelRange(scale, 'intensity')
	const intensityStep = scale === 'dmx' ? 25 : 10
	const intensityRotaryStep = scale === 'dmx' ? 10 : 5

	// Layered tiles follow the fixture's name and are shaded while it is offline
	const tileBase = fixture
		? { label: v(fixture.id, 'model'), fixtureId: fixture.id }
		: { label: label, fixtureId: null }
	const intensityNow = fixture ? `${v(fixture.id, 'intensity')}${intensitySuffix}` : 'Intensity'

	const button = (
		suffix: string,
		name: string,
		text: string,
		bgcolor: number,
		tile: StatusLook,
		action: PresetAction | null,
		states: TileState[],
	): string => {
		const id = `${sectionId}_${suffix}`
		presets[id] = statusPreset(
			{ name: `${label}: ${name}`, steps: action ? [{ down: [action], up: [] }] : [] },
			{ ...tileBase, ...tile, states },
			{ style: buttonStyle(text, bgcolor) },
		)
		return id
	}

	const levelButton = (suffix: string, name: string, text: string, tile: LevelLook): string => {
		const id = `${sectionId}_${suffix}`
		presets[id] = levelPreset(
			{ name: `${label}: ${name}`, steps: [] },
			{ ...tileBase, ...tile },
			{ style: buttonStyle(text, BLACK) },
		)
		return id
	}

	const rotary = (
		suffix: string,
		name: string,
		text: string,
		adjust: (delta: number) => PresetAction,
		step: number,
		keywords: string[],
		tile: LevelLook | null,
	): string => {
		const id = `${sectionId}_${suffix}`
		const shared = {
			name: `${label}: ${name} (rotary)`,
			steps: [{ down: [], up: [], rotate_left: [adjust(-step)], rotate_right: [adjust(step)] }],
			keywords: ['encoder', 'dial', 'knob', ...keywords],
		}
		const simple = { style: buttonStyle(text, GREY), previewStyle: { text: line('Rotary') } }
		presets[id] = tile
			? levelPreset(shared, { ...tileBase, ...tile }, simple)
			: statusPreset(shared, { ...tileBase, title: name, status: 'Rotate', accent: Colors.idle, states: [] }, simple)
		return id
	}

	const control = [
		button(
			'full',
			'Full',
			line('FULL'),
			WHITE,
			{ title: 'FULL', status: intensityNow, accent: Colors.idle },
			{ actionId: 'set_intensity', options: { ...selection, intensity: level('intensity', 100) } },
			[
				{
					when: { feedbackId: 'intensity_above', options: { ...selection, threshold: level('intensity', 99) } },
					style: { bgcolor: combineRgb(0, 200, 0) },
					accent: Colors.live,
				},
			],
		),
		button(
			'off',
			'Off',
			line('OFF'),
			BLACK,
			{ title: 'OFF', status: intensityNow, accent: Colors.idle },
			{ actionId: 'set_intensity', options: { ...selection, intensity: level('intensity', 0) } },
			[],
		),
		...[intensityStep, -intensityStep].map((delta) => {
			const text = `${delta > 0 ? '+' : ''}${delta}${intensitySuffix}`
			return button(
				delta > 0 ? 'up' : 'down',
				text,
				line(text),
				GREY,
				{ title: text, status: intensityNow, accent: Colors.idle },
				{ actionId: 'adjust_intensity', options: { ...selection, delta } },
				[],
			)
		}),
		rotary(
			'rotary',
			'Intensity',
			line(fixture ? `${v(fixture.id, 'intensity')}${intensitySuffix}` : 'INTENSITY'),
			(delta) => ({ actionId: 'adjust_intensity', options: { ...selection, delta } }),
			intensityRotaryStep,
			[],
			fixture
				? {
						title: 'Intensity',
						value: v(fixture.id, 'intensity'),
						suffix: intensitySuffix,
						min: intensityMin,
						max: intensityMax,
						accent: Colors.live,
					}
				: null,
		),
	]
	// Individual fixtures get Kelvin buttons in their CCT Controls group instead
	if (!fixture) {
		for (const cct of [3200, 5600]) {
			const color = combineRgb(255, 220, 160)
			control.push(
				button(
					`cct${cct}`,
					`${cct}K`,
					line(`${cct}K`),
					color,
					{ title: `${cct}K`, status: 'CCT', accent: color },
					{ actionId: 'set_cct', options: { ...selection, cct } },
					[],
				),
			)
		}
	}
	group('group', 'Control', fixture ? 'Intensity' : 'Intensity and color temperature', control)

	if (!fixture) {
		group('discovery', 'Discovery', 'Search for fixtures now, or forget ones that are offline', [
			button(
				'search',
				'Search for Fixtures',
				line('SEARCH'),
				GREY,
				{ title: 'SEARCH', status: '$(lyra:fixture_count) found', accent: Colors.idle },
				{ actionId: 'discover', options: {} },
				[],
			),
			button(
				'forget_offline',
				'Forget Offline Fixtures',
				line('FORGET\\nOFFLINE'),
				GREY,
				{ title: 'FORGET', status: '$(lyra:fixtures_offline) offline', accent: Colors.idle },
				{ actionId: 'forget_offline_fixtures', options: {} },
				[],
			),
		])
	}

	// Color groups only per fixture: fixtures can have different supported modes, so "all" doesn't make sense
	if (fixture) {
		const { profile } = fixture

		if (profile.modeChannel) {
			group(
				'modes',
				'Color Mode',
				'Switch between CCT, HSI and RGB',
				COLOR_MODES.map((mode) =>
					button(
						`mode_${mode.id}`,
						`${mode.label} Mode`,
						line(mode.label),
						BLACK,
						{ title: mode.label, status: 'Mode', accent: Colors.idle },
						{ actionId: 'set_mode', options: { fixtures: [fixture.id], mode: mode.id } },
						[
							{
								when: { feedbackId: 'color_mode', options: { fixtures: [fixture.id], mode: mode.id } },
								style: { bgcolor: combineRgb(0, 0, 200) },
								accent: Colors.info,
								status: 'Active',
							},
						],
					),
				),
			)
		}

		const cctLayout = profile.modes.cct
		if (cctLayout) {
			const { min, max } = profile.cctRange
			const ids = CCT_PRESETS.filter((k) => k >= min && k <= max).map((cct) => {
				const color = kelvinColor(cct, min, max)
				return button(
					`cct_${cct}`,
					`${cct}K`,
					line(`${cct}K`),
					color,
					{ title: `${cct}K`, status: 'CCT', accent: color },
					{ actionId: 'set_cct', options: { ...selection, cct } },
					[],
				)
			})
			ids.push(
				rotary(
					'cct_rotary',
					'Color Temperature',
					line(`${v(fixture.id, 'cct')}K`),
					(delta) => ({ actionId: 'adjust_cct', options: { ...selection, delta } }),
					100,
					['kelvin'],
					{ title: 'Kelvin', value: v(fixture.id, 'cct'), suffix: 'K', min, max, accent: Colors.warm },
				),
			)
			if (cctLayout.greenMagenta) {
				for (const gm of GREEN_MAGENTA_PRESETS) {
					ids.push(
						button(
							`gm_${gm.id}`,
							gm.label,
							line(gm.text),
							gm.color,
							{ title: gm.text, status: 'G/M', accent: gm.color },
							{ actionId: 'set_green_magenta', options: { ...selection, value: level('greenMagenta', gm.value) } },
							[],
						),
					)
				}
			}
			group(
				'cct_controls',
				'CCT Controls',
				profile.modeChannel ? 'Color temperature and green/magenta (switches to CCT mode)' : 'Color temperature',
				ids,
			)
		}

		if (profile.modes.hsi) {
			group(
				'hsi_controls',
				'HSI Controls',
				'Hue and saturation (switches to HSI mode)',
				COLOR_PRESETS.map((c) =>
					button(
						`hsi_${c.id}`,
						`HSI ${c.label}`,
						line(c.label),
						combineRgb(...c.rgb),
						{ title: c.label, status: 'HSI', accent: combineRgb(...c.rgb) },
						{
							actionId: 'set_hsi',
							options: { ...selection, hue: c.hue, saturation: level('saturation', c.saturation) },
						},
						[],
					),
				),
			)
		}

		if (profile.modes.rgb) {
			group(
				'rgb_controls',
				'RGB Controls',
				'Red, green and blue mixes (switches to RGB mode)',
				COLOR_PRESETS.map((c) =>
					button(
						`rgb_${c.id}`,
						`RGB ${c.label}`,
						line(c.label),
						combineRgb(...c.rgb),
						{ title: c.label, status: 'RGB', accent: combineRgb(...c.rgb) },
						{
							actionId: 'set_rgb',
							options: {
								...selection,
								red: level('red', c.rgb[0]),
								green: level('green', c.rgb[1]),
								blue: level('blue', c.rgb[2]),
							},
						},
						[],
					),
				),
			)
		}

		const statusLine = (text: string) => `${fixture.name}\\n${text}`
		const status = [
			levelButton(
				'status_intensity',
				'current intensity',
				statusLine(`${v(fixture.id, 'intensity')}${intensitySuffix}`),
				{
					title: 'Intensity',
					value: v(fixture.id, 'intensity'),
					suffix: intensitySuffix,
					min: intensityMin,
					max: intensityMax,
					accent: Colors.live,
				},
			),
			levelButton('status_cct', 'current color temperature', statusLine(`${v(fixture.id, 'cct')}K`), {
				title: 'Kelvin',
				value: v(fixture.id, 'cct'),
				suffix: 'K',
				min: profile.cctRange.min,
				max: profile.cctRange.max,
				accent: Colors.warm,
			}),
		]
		if (profile.modeChannel) {
			status.push(
				button(
					'status_mode',
					'current mode',
					statusLine(v(fixture.id, 'mode')),
					BLACK,
					{ title: 'Mode', status: v(fixture.id, 'mode'), accent: Colors.info },
					null,
					[],
				),
			)
		}
		group('status', 'Status', 'Current values', status)
	}

	return { id: sectionId, name: label, definitions: groups }
}

/** Recall and save buttons for the first light preset slots */
function buildLightPresetSection(presets: CompanionPresetDefinitions<ModuleSchema>): CompanionPresetSection {
	const slots = Array.from({ length: LIGHT_PRESET_BUTTONS }, (_, i) => i + 1)
	const tileBase = { label: 'Light Preset', fixtureId: null }
	const recallIds = slots.map((slot) => {
		const id = `light_preset_recall_${slot}`
		presets[id] = statusPreset(
			{
				name: `Recall Light Preset ${slot}`,
				steps: [{ down: [{ actionId: 'recall_light_preset', options: { slot } }], up: [] }],
				keywords: ['scene', 'look', 'memory'],
			},
			{
				...tileBase,
				title: `${slot}`,
				status: 'Recall',
				accent: Colors.idle,
				states: [
					{
						when: { feedbackId: 'light_preset_active', options: { slot } },
						style: { bgcolor: combineRgb(0, 200, 0), color: BLACK },
						accent: Colors.live,
						status: 'Active',
					},
				],
			},
			{ style: buttonStyle(`PRESET\\n${slot}`, GREY) },
		)
		return id
	})
	const saveIds = slots.map((slot) => {
		const id = `light_preset_save_${slot}`
		presets[id] = statusPreset(
			{
				name: `Save Light Preset ${slot}`,
				steps: [
					{
						down: [{ actionId: 'save_light_preset', options: { target: 'all', fixtures: [], slot } }],
						up: [],
					},
				],
				keywords: ['store', 'scene', 'look', 'memory'],
			},
			{
				...tileBase,
				title: `${slot}`,
				status: 'Save',
				accent: Colors.idle,
				states: [
					{
						when: { feedbackId: 'light_preset_saved', options: { slot } },
						style: { text: `RESAVE\\n${slot}`, bgcolor: combineRgb(200, 0, 0), color: WHITE },
						accent: Colors.stop,
						status: 'Resave',
					},
				],
			},
			{ style: buttonStyle(`SAVE\\n${slot}`, combineRgb(140, 50, 50)) },
		)
		return id
	})

	return {
		id: 'light_presets',
		name: 'Presets',
		definitions: [
			{
				id: 'light_presets_recall',
				name: 'Recall',
				description: 'Lit while every fixture in the preset still matches it',
				type: 'simple',
				presets: recallIds,
			},
			{
				id: 'light_presets_save',
				name: 'Save',
				description: 'Store the current state of all fixtures in the slot; lit when the slot already holds a preset',
				type: 'simple',
				presets: saveIds,
			},
		],
	}
}

export function UpdatePresets(self: IkanInstance): void {
	const presets: CompanionPresetDefinitions<ModuleSchema> = {}
	const scale = self.config.valueScale
	const structure = [
		buildSection(presets, scale, 'all', 'All Fixtures', null),
		buildLightPresetSection(presets),
		...self.fixtures.fixtures.map((f) => buildSection(presets, scale, f.id, `${f.name} (DMX ${f.dmx.dmxAddress})`, f)),
	]
	self.setPresetDefinitions(structure, presets)
}
