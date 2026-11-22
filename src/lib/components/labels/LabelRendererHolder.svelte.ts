/**
 * The renderer half of a mark's label host (label-host.ts), owned by the MARK
 * and filled in by its renderer while one is mounted.
 *
 * Why the mark owns it: a mark mounts its renderer only while it has data, and
 * a label can change the mark's query (a text column, `addSelect`), which
 * rebuilds the mark and remounts the renderer. Labels inside the renderer
 * would unmount with it, take their column back out, change the query again,
 * and loop. So labels live under the mark, outside that gate, and reach the
 * renderer through this holder: `attach` when it is ready, `detach` when it
 * goes. Everything a label reads through it is looked up when read, so a
 * remount simply rebinds.
 *
 * Slot channel numbers are allocated here, so a layer keeps its binding across
 * renderers; the new renderer gets the slots written again by the label.
 */

import type { BaseGPURenderer } from '$lib/components/rendering/BaseGPURenderer.svelte';
import type { LabelHostColor, LabelRendererHost } from './label-host';

/** What a mounted renderer provides. */
export interface AttachedRenderer {
	renderer(): BaseGPURenderer | null;
	recordBinding: number;
	color(): LabelHostColor;
	/** Each row's facet index in a facet grid (LabelRendererHost.facets). */
	facets(): GPUBuffer | undefined;
}

/** Bindings past every binding a host's draw and kernels declare. */
const FIRST_SLOT_CHANNEL = 16;

export class LabelRendererHolder implements LabelRendererHost {
	// Raw: a deep $state would hold a proxy of the attached object, which detach's
	// `===` against the caller's own object never matches, so it never cleared.
	#attached = $state.raw<AttachedRenderer | null>(null);
	#next = FIRST_SLOT_CHANNEL;
	#free: number[] = [];
	readonly recordWGSL: string;
	readonly recordKind: string;

	constructor(recordKind: string, recordWGSL: string) {
		this.recordKind = recordKind;
		this.recordWGSL = recordWGSL;
	}

	attach(renderer: AttachedRenderer): () => void {
		this.#attached = renderer;
		return () => {
			if (this.#attached === renderer) this.#attached = null;
		};
	}

	get attached(): boolean {
		return this.#attached !== null;
	}

	renderer(): BaseGPURenderer | null {
		return this.#attached?.renderer() ?? null;
	}

	get recordBinding(): number {
		return this.#attached?.recordBinding ?? -1;
	}

	allocateSlotChannel(): number {
		return this.#free.pop() ?? this.#next++;
	}

	releaseSlotChannel(binding: number): void {
		this.renderer()?.releaseAttribute(binding);
		this.#free.push(binding);
	}

	color(): LabelHostColor {
		return this.#attached?.color() ?? { mode: 0, scaleIndex: 0, constant: [0, 0, 0, 1] };
	}

	facets(): GPUBuffer | undefined {
		return this.#attached?.facets();
	}
}
