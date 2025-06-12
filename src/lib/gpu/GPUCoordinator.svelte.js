// src/lib/gpu/GPUCoordinator.svelte.js
import { setContext, getContext } from 'svelte';

export class GPUCoordinator {
  // ... coordinator logic
}

export function setGPUCoordinator() {
  const coordinator = new GPUCoordinator();
  return setContext('gpu-coordinator', coordinator);
}

export function getGPUContext() {
  return getContext('gpu-coordinator');
}
