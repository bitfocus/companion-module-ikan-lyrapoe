import {
	ButtonGraphicsDecorationType,
	combineRgb,
	splitRgb,
	type CompanionButtonStepActions,
	type CompanionButtonStyleProps,
	type CompanionPresetDefinitions,
	type CompanionPresetFeedback,
	type SomeButtonGraphicsElement,
} from '@companion-module/base'
import type { FeedbacksSchema } from './feedbacks.js'
import type { ModuleSchema } from './main.js'

export const Colors = {
	white: combineRgb(255, 255, 255),
	black: combineRgb(0, 0, 0),
	tile: combineRgb(21, 24, 30),
	muted: combineRgb(183, 188, 198),
	idle: combineRgb(58, 63, 75),
	live: combineRgb(31, 157, 77),
	info: combineRgb(37, 99, 235),
	stop: combineRgb(198, 40, 40),
	warm: combineRgb(255, 170, 80),
} as const

/** Black or white, whichever reads better on the background */
export function textOn(bgcolor: number): number {
	const { r, g, b } = splitRgb(bgcolor)
	return r * 0.299 + g * 0.587 + b * 0.114 < 140 ? Colors.white : Colors.black
}

type FeedbackOn =
	CompanionPresetFeedback<FeedbacksSchema> extends infer T
		? T extends { feedbackId: infer Id; options: infer Options }
			? { feedbackId: Id; options: Options }
			: never
		: never

/** A feedback, and how each variant shows it */
export type TileState = {
	when: FeedbackOn
	/** Style the simple variant takes while the feedback is active */
	style: Partial<CompanionButtonStyleProps>
	/** Color the layered tile's status strip takes while the feedback is active */
	accent: number
	/** Text the status strip shows instead while the feedback is active */
	status?: string
}

/** What both variants share */
export type TileShared = {
	name: string
	keywords?: string[]
	steps: CompanionButtonStepActions<ModuleSchema>[]
}

/** The simple variant's look: the style offered before layered buttons, for hosts without them */
export type SimpleLook = {
	style: CompanionButtonStyleProps
	previewStyle?: Partial<CompanionButtonStyleProps>
}

type TileBase = {
	/** Fixture name (or what the tile is for) along the top; may contain variables */
	label: string
	/** Fixture whose tile is shaded while it is offline; null when the tile isn't for one fixture */
	fixtureId: string | null
}

export type StatusTile = TileBase & {
	title: string
	/** Text in the status strip; may contain variables */
	status: string
	accent: number
	states: TileState[]
}

export type LevelTile = TileBase & {
	title: string
	/** Variable holding the level */
	value: string
	/** Appended to the value, e.g. "%" or "K" */
	suffix: string
	min: number
	max: number
	accent: number
}

const expr = (value: string) => ({ isExpression: true as const, value })

/** A shade over the whole tile, off until the offline feedback turns it on */
function withOfflineShade(tile: TileBase, elements: SomeButtonGraphicsElement[]): SomeButtonGraphicsElement[] {
	if (!tile.fixtureId) return elements
	return [
		...elements,
		{
			type: 'box',
			id: 'offline',
			name: 'Offline Shade',
			x: 0,
			y: 0,
			width: 100,
			height: 100,
			color: Colors.tile,
			opacity: 60,
			enabled: false,
		},
	]
}

function offlineFeedbacks(tile: TileBase) {
	if (!tile.fixtureId) return []
	return [
		{
			feedbackId: 'fixture_online' as const,
			options: { target: 'select' as const, fixtures: [tile.fixtureId] },
			isInverted: true,
			headline: 'Shade while offline',
			styleOverrides: [{ elementId: 'offline', elementProperty: 'enabled', override: true }],
		},
	]
}

function backgroundAndLabel(tile: TileBase): SomeButtonGraphicsElement[] {
	return [
		{
			type: 'box',
			id: 'background',
			name: 'Background',
			x: 0,
			y: 0,
			width: 100,
			height: 100,
			color: Colors.tile,
		},
		{
			type: 'text',
			id: 'label',
			name: 'Fixture Name',
			x: 3,
			y: 2,
			width: 94,
			height: 20,
			text: tile.label,
			color: Colors.muted,
		},
	]
}

/** Status tile drawn as editable elements: fixture name, title, and a color status strip */
function statusElements(tile: StatusTile): SomeButtonGraphicsElement[] {
	return [
		...backgroundAndLabel(tile),
		{
			type: 'text',
			id: 'title',
			name: 'Action Title',
			x: 3,
			y: 27,
			width: 94,
			height: 40,
			text: tile.title,
			weight: 'bold',
			color: Colors.white,
		},
		{
			type: 'box',
			id: 'accent',
			name: 'Status Color',
			x: 0,
			y: 70,
			width: 100,
			height: 30,
			color: tile.accent,
		},
		{
			type: 'text',
			id: 'status',
			name: 'Status Text',
			x: 3,
			y: 70,
			width: 94,
			height: 30,
			text: tile.status,
			weight: 'bold',
			color: textOn(tile.accent),
		},
	]
}

/** Level tile drawn as editable elements: fixture name, ring gauge, value, and title */
function levelElements(tile: LevelTile): SomeButtonGraphicsElement[] {
	return [
		...backgroundAndLabel(tile),
		{
			type: 'gauge',
			id: 'ring',
			name: 'Level Ring',
			x: 11,
			y: 22,
			width: 78,
			height: 78,
			orientation: 'ring',
			min: tile.min,
			max: tile.max,
			value: expr(tile.value),
			startAngle: 225,
			endAngle: 135,
			ringWidth: 12,
			multiColour: false,
			stops: [{ value: tile.min, color: tile.accent, gradient: false }],
			trackStyle: 'dimmed',
			trackAmount: 25,
		},
		{
			type: 'text',
			id: 'value',
			name: 'Level Value',
			// Inside the ring's opening
			x: 23,
			y: 50,
			width: 54,
			height: 22,
			text: `${tile.value}${tile.suffix}`,
			weight: 'bold',
			color: Colors.white,
		},
		{
			type: 'text',
			id: 'title',
			name: 'Level Title',
			// In the gap at the bottom of the ring
			x: 30,
			y: 84,
			width: 40,
			height: 14,
			text: tile.title,
			color: Colors.muted,
		},
	]
}

type Preset = CompanionPresetDefinitions<ModuleSchema>[string]

export function statusPreset(shared: TileShared, tile: StatusTile, simple: SimpleLook): Preset {
	return {
		type: 'alternatives',
		variants: [
			{
				type: 'layered',
				...shared,
				canvas: { decoration: ButtonGraphicsDecorationType.None },
				elements: withOfflineShade(tile, statusElements(tile)),
				feedbacks: [
					...tile.states.map(({ when, accent, status }) => ({
						...when,
						styleOverrides: [
							{ elementId: 'accent', elementProperty: 'color', override: accent },
							{ elementId: 'status', elementProperty: 'color', override: textOn(accent) },
							...(status === undefined ? [] : [{ elementId: 'status', elementProperty: 'text', override: status }]),
						],
					})),
					...offlineFeedbacks(tile),
				],
			},
			{
				type: 'simple',
				...shared,
				...simple,
				feedbacks: tile.states.map(({ when, style }) => ({ ...when, style })),
			},
		],
	}
}

export function levelPreset(shared: TileShared, tile: LevelTile, simple: SimpleLook): Preset {
	return {
		type: 'alternatives',
		variants: [
			{
				type: 'layered',
				...shared,
				canvas: { decoration: ButtonGraphicsDecorationType.None },
				elements: withOfflineShade(tile, levelElements(tile)),
				feedbacks: offlineFeedbacks(tile),
			},
			{ type: 'simple', ...shared, ...simple, feedbacks: [] },
		],
	}
}
