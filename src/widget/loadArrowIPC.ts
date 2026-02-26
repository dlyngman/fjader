/**
 * Load Arrow IPC bytes into DuckDB-WASM via insertArrowFromIPCStream.
 */

import type { Coordinator } from '@uwdata/mosaic-core';

export async function loadArrowIPCTable(
	coordinator: Coordinator,
	tableName: string,
	ipcBytes: Uint8Array
): Promise<void> {
	// Drop existing table first — re-execution sends the same table name
	await coordinator.exec(`DROP TABLE IF EXISTS "${tableName}"`);

	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const connector = coordinator.databaseConnector() as any;
	const connection = await connector.getConnection();
	await connection.insertArrowFromIPCStream(ipcBytes, {
		name: tableName,
		create: true
	});
}
