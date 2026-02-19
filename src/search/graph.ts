import type { DatabaseSync } from "node:sqlite";

/**
 * A knowledge graph link between two nodes
 */
export type GraphLink = {
  fromId: string;
  toId: string;
  relation: string;
  layer: string | null;
  weight: number;
  sourcePath: string | null;
};

/**
 * A neighbor node discovered during graph traversal
 */
export type GraphNeighbor = {
  id: string;
  depth: number;
  link: GraphLink;
};

/**
 * Get all outgoing links from a node.
 */
export function getLinksFrom(
  db: DatabaseSync,
  fromId: string,
  opts?: { relation?: string; layer?: string },
): GraphLink[] {
  let sql = `SELECT from_id, to_id, relation, layer, weight, source_path FROM knowledge_links WHERE from_id = ?`;
  const params: (string | number)[] = [fromId];

  if (opts?.relation) {
    sql += ` AND relation = ?`;
    params.push(opts.relation);
  }
  if (opts?.layer) {
    sql += ` AND layer = ?`;
    params.push(opts.layer);
  }

  const rows = db.prepare(sql).all(...params) as Array<{
    from_id: string;
    to_id: string;
    relation: string;
    layer: string | null;
    weight: number;
    source_path: string | null;
  }>;

  return rows.map(toGraphLink);
}

/**
 * Get all incoming links to a node.
 */
export function getLinksTo(
  db: DatabaseSync,
  toId: string,
  opts?: { relation?: string; layer?: string },
): GraphLink[] {
  let sql = `SELECT from_id, to_id, relation, layer, weight, source_path FROM knowledge_links WHERE to_id = ?`;
  const params: (string | number)[] = [toId];

  if (opts?.relation) {
    sql += ` AND relation = ?`;
    params.push(opts.relation);
  }
  if (opts?.layer) {
    sql += ` AND layer = ?`;
    params.push(opts.layer);
  }

  const rows = db.prepare(sql).all(...params) as Array<{
    from_id: string;
    to_id: string;
    relation: string;
    layer: string | null;
    weight: number;
    source_path: string | null;
  }>;

  return rows.map(toGraphLink);
}

/**
 * BFS traversal to find neighbors up to a given depth.
 *
 * @param db - Database handle
 * @param startId - The starting node ID
 * @param depth - Maximum traversal depth (default: 1)
 * @param opts - Optional filters for relation and layer
 * @returns Array of neighbor nodes with their depth and connecting link
 */
export function getNeighbors(
  db: DatabaseSync,
  startId: string,
  depth: number = 1,
  opts?: { relation?: string; layer?: string },
): GraphNeighbor[] {
  const visited = new Set<string>([startId]);
  const result: GraphNeighbor[] = [];
  let frontier = [startId];

  for (let d = 1; d <= depth; d++) {
    const nextFrontier: string[] = [];

    for (const nodeId of frontier) {
      // Follow outgoing links
      const outgoing = getLinksFrom(db, nodeId, opts);
      for (const link of outgoing) {
        if (!visited.has(link.toId)) {
          visited.add(link.toId);
          nextFrontier.push(link.toId);
          result.push({ id: link.toId, depth: d, link });
        }
      }

      // Follow incoming links
      const incoming = getLinksTo(db, nodeId, opts);
      for (const link of incoming) {
        if (!visited.has(link.fromId)) {
          visited.add(link.fromId);
          nextFrontier.push(link.fromId);
          result.push({ id: link.fromId, depth: d, link });
        }
      }
    }

    frontier = nextFrontier;
    if (frontier.length === 0) break;
  }

  return result;
}

/**
 * BFS shortest path between two nodes, max depth 3.
 *
 * @returns Array of links forming the path, or empty if no path found.
 */
export function getPathBetween(
  db: DatabaseSync,
  fromId: string,
  toId: string,
  maxDepth: number = 3,
): GraphLink[] {
  if (fromId === toId) return [];

  // BFS with parent tracking
  const visited = new Set<string>([fromId]);
  // Maps each visited node to the link that discovered it
  const parentLink = new Map<string, GraphLink>();
  let frontier = [fromId];

  for (let d = 0; d < maxDepth; d++) {
    const nextFrontier: string[] = [];

    for (const nodeId of frontier) {
      // Follow outgoing links
      const outgoing = getLinksFrom(db, nodeId);
      for (const link of outgoing) {
        if (!visited.has(link.toId)) {
          visited.add(link.toId);
          parentLink.set(link.toId, link);
          if (link.toId === toId) {
            return reconstructPath(parentLink, fromId, toId);
          }
          nextFrontier.push(link.toId);
        }
      }

      // Follow incoming links
      const incoming = getLinksTo(db, nodeId);
      for (const link of incoming) {
        if (!visited.has(link.fromId)) {
          visited.add(link.fromId);
          parentLink.set(link.fromId, link);
          if (link.fromId === toId) {
            return reconstructPath(parentLink, fromId, toId);
          }
          nextFrontier.push(link.fromId);
        }
      }
    }

    frontier = nextFrontier;
    if (frontier.length === 0) break;
  }

  return []; // No path found
}

/**
 * Reconstruct the path from BFS parent map.
 */
function reconstructPath(
  parentLink: Map<string, GraphLink>,
  fromId: string,
  toId: string,
): GraphLink[] {
  const path: GraphLink[] = [];
  let current = toId;

  while (current !== fromId) {
    const link = parentLink.get(current);
    if (!link) break;
    path.unshift(link);
    // Determine which side led to `current`
    current = link.toId === current ? link.fromId : link.toId;
  }

  return path;
}

function toGraphLink(row: {
  from_id: string;
  to_id: string;
  relation: string;
  layer: string | null;
  weight: number;
  source_path: string | null;
}): GraphLink {
  return {
    fromId: row.from_id,
    toId: row.to_id,
    relation: row.relation,
    layer: row.layer,
    weight: row.weight,
    sourcePath: row.source_path,
  };
}
