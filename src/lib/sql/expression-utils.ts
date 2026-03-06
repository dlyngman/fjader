import { isNode } from '@uwdata/mosaic-sql';

/** Check if an AST node is a window expression (e.g. sum('x').partitionby(...).orderby(...)). */
export function isWindowExpression(node: unknown): boolean {
	return isNode(node) && (node as { type: string }).type === 'WINDOW';
}
