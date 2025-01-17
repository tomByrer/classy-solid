import {
	createSignal as _createSignal,
	createEffect,
	onCleanup,
	getOwner,
	runWithOwner,
	Signal,
	Accessor,
	Setter,
} from 'solid-js'

import type {EffectFunction, EffectOptions, SignalOptions} from 'solid-js/types/reactive/signal'

const effectQueue: Set<EffectFunction<any>> = new Set()
let runningEffects = false

// map of effects to dependencies
const effectDeps = new Map<EffectFunction<any>, Set<(v: any) => any>>()
let currentEffect: EffectFunction<any> = () => {}

// Override createSignal in order to implement custom tracking of effect
// dependencies, so that when signals change, we are aware which dependenct
// effects needs to be moved to the end of the effect queue while running
// deferred effects in a microtask.
export function createSignal<T>(): Signal<T | undefined>
export function createSignal<T>(value: T, options?: SignalOptions<T>): Signal<T>
export function createSignal<T>(value?: T, options?: SignalOptions<T>): Signal<T | undefined> {
	let [_get, _set] = _createSignal(value as any, options)

	const get: Accessor<T> = () => {
		if (!runningEffects) return _get()

		let deps = effectDeps.get(currentEffect)
		if (!deps) effectDeps.set(currentEffect, (deps = new Set()))
		deps.add(_set)

		return _get()
	}

	const set: Setter<T | undefined> = v => {
		if (!runningEffects) return _set(v as any)

		// This is inefficient, for proof of concept, unable to use Solid
		// internals on the outside.
		for (const [fn, deps] of effectDeps) {
			for (const dep of deps) {
				if (dep === _set) {
					// move to the end
					effectQueue.delete(fn)
					effectQueue.add(fn)
				}
			}
		}

		return _set(v as any)
	}

	return [get, set]
}

let effectTaskIsScheduled = false

// TODO Option so the first run is deferred instead of immediate? This already
// happens outside of a root.
export function createDeferredEffect<Next, Init = Next>(
	fn: EffectFunction<Init | Next, Next>,
	value: Init,
	options?: EffectOptions,
): void
export function createDeferredEffect<Next, Init = undefined>(
	..._: undefined extends Init
		? [fn: EffectFunction<Init | Next, Next>, value?: Init, options?: EffectOptions]
		: [fn: EffectFunction<Init | Next, Next>, value: Init, options?: EffectOptions]
): void
export function createDeferredEffect<Next, Init = Next>(
	fn: EffectFunction<Init | Next, Next>,
	value: Init,
	options?: EffectOptions,
): void {
	let initial = true

	createEffect(
		(prev: any) => {
			if (initial) {
				initial = false

				currentEffect = fn
				effectDeps.get(fn)?.clear() // clear to track deps, or else it won't track new deps based on code branching
				fn(prev)

				return
			}

			effectQueue.add(fn) // add, or move to the end, of the queue. TODO This is probably redundant now, but I haven't tested yet.

			// If we're currently running the queue, return because fn will run
			// again at the end of the queue iteration due to our overriden
			// createSignal moving it to the end.
			if (runningEffects) return

			if (effectTaskIsScheduled) return

			effectTaskIsScheduled = true

			const owner = getOwner()

			queueMicrotask(() => {
				if (owner) runWithOwner(owner, runEffects)
				else runEffects()
			})
		},
		value,
		options,
	)

	getOwner() &&
		onCleanup(() => {
			effectDeps.delete(fn)
			effectQueue.delete(fn)
		})
}

function runEffects() {
	runningEffects = true

	for (const fn of effectQueue) {
		effectQueue.delete(fn) // TODO This is probably redundant now, but I haven't tested yet.
		createDeferredEffect(fn)
	}

	runningEffects = false
	effectTaskIsScheduled = false
}
