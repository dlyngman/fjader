import type { PointerEventHandler } from 'svelte/elements';

declare module 'svelte/elements' {
	// pointerrawupdate (Chromium) is missing from Svelte's DOM typings. ChartCell
	// listens to it for hover at the device's full pointer rate.
	interface DOMAttributes<T extends EventTarget> {
		onpointerrawupdate?: PointerEventHandler<T> | undefined | null;
	}
}

export {};
