/**
 * Load Arrow IPC bytes into DuckDB-WASM via insertArrowFromIPCStream.
 */

import type { Coordinator } from '@uwdata/mosaic-core';

/** Minimal typing for DuckDB-WASM connector accessed through Mosaic. */
interface DuckDBConnection {
	insertArrowFromIPCStream(data: Uint8Array, options: { name: string; create: boolean }): Promise<void>;
}

interface WasmConnector {
	getConnection(): Promise<DuckDBConnection>;
}

export async function loadArrowIPCTable(
	coordinator: Coordinator,
	tableName: string,
	ipcBytes: Uint8Array
): Promise<void> {
	// Drop existing table first — re-execution sends the same table name
	await coordinator.exec(`DROP TABLE IF EXISTS "${tableName}"`);

	const connector = coordinator.databaseConnector() as WasmConnector;
	const connection = await connector.getConnection();
	await connection.insertArrowFromIPCStream(ipcBytes, {
		name: tableName,
		create: true
	});
}
