import { describe, it, expect, vi } from 'vitest';
import { BuildQueue, type BuildQueueHost, type QueuedBuild } from './BuildQueue';

/** A host whose exec waits until the test settles it, and records outcomes. */
function host(opts: { finishDespiteAbort?: boolean } = {}) {
	const outcomes: string[] = [];
	const running: {
		sql: string;
		signal: AbortSignal;
		resolve: () => void;
		reject: (e: unknown) => void;
	}[] = [];
	const h: BuildQueueHost = {
		exec: (sql, signal) =>
			new Promise<void>((resolve, reject) => {
				running.push({ sql, signal, resolve, reject });
				signal.addEventListener('abort', () => {
					if (!opts.finishDespiteAbort) reject(new DOMException('aborted', 'AbortError'));
				});
			}),
		busy: () => false,
		stillWanted: () => true,
		dropped: (item) => outcomes.push(`dropped ${item.markId}`),
		built: (item) => outcomes.push(`built ${item.markId}`),
		failed: (item) => outcomes.push(`failed ${item.markId}`)
	};
	return { h, outcomes, running };
}

function build(markId: string): Omit<QueuedBuild, 'batch' | 'queuedAt' | 'done'> {
	return { markId, sourceId: 's', build: {} as never, createSQL: `CREATE ${markId}` };
}

describe('BuildQueue cancellation', () => {
	it('cancels the running build of a dropped mark: dropped, not failed', async () => {
		const { h, outcomes, running } = host();
		const q = new BuildQueue(h, 100);
		q.ensureBatch();
		const done = q.push(build('m1'));
		q.pump();
		q.abortRunning((item) => item.markId === 'm1');
		await done;
		expect(running[0].signal.aborted).toBe(true);
		expect(outcomes).toEqual(['dropped m1']);
	});

	it('leaves a build of another mark running', async () => {
		const { h, outcomes, running } = host();
		const q = new BuildQueue(h, 100);
		q.ensureBatch();
		const done = q.push(build('m1'));
		q.pump();
		q.abortRunning((item) => item.markId === 'other');
		running[0].resolve();
		await done;
		expect(outcomes).toEqual(['built m1']);
	});

	it('does not land a build that finished despite its cancel (the race)', async () => {
		const { h, outcomes, running } = host({ finishDespiteAbort: true });
		const q = new BuildQueue(h, 100);
		q.ensureBatch();
		const done = q.push(build('m1'));
		q.pump();
		q.abortRunning(() => true);
		running[0].resolve();
		await done;
		expect(outcomes).toEqual(['dropped m1']);
	});

	it('clear (a reload) cancels the running build and drops the queued ones', async () => {
		const { h, outcomes } = host();
		const q = new BuildQueue(h, 100);
		q.ensureBatch();
		const a = q.push(build('m1'));
		const b = q.push(build('m2'));
		q.pump();
		q.clear();
		await Promise.all([a, b]);
		expect(outcomes.sort()).toEqual(['dropped m1', 'dropped m2']);
	});

	it('destroy cancels the running build', async () => {
		const { h, running } = host();
		const q = new BuildQueue(h, 100);
		q.ensureBatch();
		void q.push(build('m1'));
		q.pump();
		q.destroy();
		expect(running[0].signal.aborted).toBe(true);
		vi.clearAllMocks();
	});
});
