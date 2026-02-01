import { join, resolve, basename } from 'path';
import { readdir, readFile } from 'node:fs/promises';
import { PathFilter } from './pathfilter.js';
import type { Graph, GraphNode, GraphEdge, GraphStats, LocalGraphParams, BacklinksResult, OutlinksResult } from './types.js';

// Regex patterns for extracting links
const WIKILINK_PATTERN = /\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|([^\]]*))?\]\]/g;
const MARKDOWN_LINK_PATTERN = /\[([^\]]*)\]\(([^)]+\.md)(?:#[^)]*)?\)/g;

interface ExtractedLink {
  target: string;
  alias?: string;
}

export class GraphService {
  private pathFilter: PathFilter;

  constructor(
    private vaultPath: string,
    pathFilter?: PathFilter
  ) {
    this.vaultPath = resolve(vaultPath);
    this.pathFilter = pathFilter || new PathFilter();
  }

  /**
   * Extract all links from markdown content
   */
  private extractLinks(content: string): ExtractedLink[] {
    const links: ExtractedLink[] = [];

    // Extract wikilinks: [[Note Name]] or [[Note Name|Alias]] or [[Note Name#Heading]]
    let match;
    while ((match = WIKILINK_PATTERN.exec(content)) !== null) {
      const matchResult = match[1];
      const aliasMatch = match[2];
      if (!matchResult) continue;

      const target = matchResult.trim();
      const alias = aliasMatch?.trim();

      // Normalize: add .md if not present
      const normalizedTarget = target.endsWith('.md') ? target : `${target}.md`;

      const link: ExtractedLink = { target: normalizedTarget };
      if (alias) {
        link.alias = alias;
      }
      links.push(link);
    }

    // Reset regex
    WIKILINK_PATTERN.lastIndex = 0;

    // Extract markdown links: [text](path.md) or [text](path.md#heading)
    while ((match = MARKDOWN_LINK_PATTERN.exec(content)) !== null) {
      const aliasMatch = match[1];
      const targetMatch = match[2];
      if (!targetMatch) continue;

      const alias = aliasMatch?.trim();
      let target = targetMatch.trim();

      // Handle relative paths
      if (target.startsWith('./')) {
        target = target.slice(2);
      }

      const link: ExtractedLink = { target };
      if (alias) {
        link.alias = alias;
      }
      links.push(link);
    }

    // Reset regex
    MARKDOWN_LINK_PATTERN.lastIndex = 0;

    return links;
  }

  /**
   * Get all markdown files in the vault
   */
  private async getAllNotes(): Promise<string[]> {
    const notes: string[] = [];

    const scanDirectory = async (dirPath: string, relativePath: string = ''): Promise<void> => {
      const entries = await readdir(dirPath, { withFileTypes: true });

      for (const entry of entries) {
        const entryRelativePath = relativePath ? `${relativePath}/${entry.name}` : entry.name;

        if (!this.pathFilter.isAllowed(entryRelativePath)) {
          continue;
        }

        const fullEntryPath = join(dirPath, entry.name);

        if (entry.isDirectory()) {
          if (!this.pathFilter.isAllowed(`${entryRelativePath}/test.md`)) {
            continue;
          }
          await scanDirectory(fullEntryPath, entryRelativePath);
        } else if (entry.isFile() && (entry.name.endsWith('.md') || entry.name.endsWith('.markdown'))) {
          notes.push(entryRelativePath);
        }
      }
    };

    await scanDirectory(this.vaultPath);
    return notes;
  }

  /**
   * Resolve a link target to an actual file path
   * Handles Obsidian's flexible linking (shortest path, case-insensitive, etc.)
   */
  private resolveLink(target: string, allNotes: Set<string>, sourceDir: string): string | null {
    // Normalize target
    const normalizedTarget = target.endsWith('.md') ? target : `${target}.md`;

    // Direct match
    if (allNotes.has(normalizedTarget)) {
      return normalizedTarget;
    }

    // Try with source directory prefix
    if (sourceDir) {
      const withDir = `${sourceDir}/${normalizedTarget}`;
      if (allNotes.has(withDir)) {
        return withDir;
      }
    }

    // Case-insensitive search and filename-only matching
    const lowerTarget = normalizedTarget.toLowerCase();
    for (const note of allNotes) {
      if (note.toLowerCase() === lowerTarget) {
        return note;
      }
      // Also try just the filename
      const noteBasename = basename(note).toLowerCase();
      const targetBasename = basename(normalizedTarget).toLowerCase();
      if (noteBasename === targetBasename) {
        return note;
      }
    }

    return null;
  }

  /**
   * Build the complete graph of the vault
   */
  async getGraph(): Promise<Graph> {
    const notes = await this.getAllNotes();
    const noteSet = new Set(notes);

    const nodeMap = new Map<string, GraphNode>();
    const edges: GraphEdge[] = [];

    // Initialize all nodes
    for (const notePath of notes) {
      const label = basename(notePath, '.md');
      nodeMap.set(notePath, {
        id: notePath,
        label,
        links: 0,
        outlinks: 0,
        backlinks: 0
      });
    }

    // Process each note to extract links
    const processPromises = notes.map(async (notePath) => {
      const fullPath = join(this.vaultPath, notePath);
      const sourceDir = notePath.includes('/') ? notePath.substring(0, notePath.lastIndexOf('/')) : '';

      try {
        const content = await readFile(fullPath, 'utf-8');
        const links = this.extractLinks(content);

        const noteEdges: GraphEdge[] = [];

        for (const link of links) {
          const resolvedTarget = this.resolveLink(link.target, noteSet, sourceDir);

          if (resolvedTarget && resolvedTarget !== notePath) {
            const edge: GraphEdge = {
              from: notePath,
              to: resolvedTarget
            };
            if (link.alias) {
              edge.label = link.alias;
            }
            noteEdges.push(edge);
          }
        }

        return { notePath, edges: noteEdges };
      } catch {
        return { notePath, edges: [] };
      }
    });

    const results = await Promise.all(processPromises);

    // Aggregate edges and update node counts
    for (const result of results) {
      for (const edge of result.edges) {
        edges.push(edge);

        // Update outlinks count for source
        const sourceNode = nodeMap.get(edge.from);
        if (sourceNode) {
          sourceNode.outlinks++;
          sourceNode.links++;
        }

        // Update backlinks count for target
        const targetNode = nodeMap.get(edge.to);
        if (targetNode) {
          targetNode.backlinks++;
          targetNode.links++;
        }
      }
    }

    return {
      nodes: Array.from(nodeMap.values()),
      edges
    };
  }

  /**
   * Get graph statistics including orphans and hubs
   */
  async getGraphStats(hubCount: number = 10): Promise<GraphStats> {
    const graph = await this.getGraph();
    const noteSet = new Set(graph.nodes.map(n => n.id));

    // Find orphans (no connections)
    const orphans = graph.nodes
      .filter(node => node.links === 0)
      .map(node => node.id);

    // Find hubs (most connected)
    const hubs = [...graph.nodes]
      .sort((a, b) => b.links - a.links)
      .slice(0, hubCount)
      .map(node => ({ path: node.id, connections: node.links }));

    // Find unresolved links (links to non-existent notes)
    const unresolvedLinks: string[] = [];

    // Re-scan for unresolved links
    const notes = await this.getAllNotes();
    for (const notePath of notes) {
      const fullPath = join(this.vaultPath, notePath);
      const sourceDir = notePath.includes('/') ? notePath.substring(0, notePath.lastIndexOf('/')) : '';

      try {
        const content = await readFile(fullPath, 'utf-8');
        const links = this.extractLinks(content);

        for (const link of links) {
          const resolved = this.resolveLink(link.target, noteSet, sourceDir);
          if (!resolved) {
            const linkName = link.target.replace(/\.md$/, '');
            if (!unresolvedLinks.includes(linkName)) {
              unresolvedLinks.push(linkName);
            }
          }
        }
      } catch {
        // Skip files that can't be read
      }
    }

    return {
      totalNodes: graph.nodes.length,
      totalEdges: graph.edges.length,
      orphans,
      hubs,
      unresolvedLinks
    };
  }

  /**
   * Get backlinks for a specific note
   */
  async getBacklinks(path: string): Promise<BacklinksResult> {
    const graph = await this.getGraph();

    // Normalize path
    const normalizedPath = path.endsWith('.md') ? path : `${path}.md`;

    const backlinks = graph.edges
      .filter(edge => edge.to === normalizedPath || edge.to.endsWith(`/${normalizedPath}`))
      .map(edge => {
        const result: { from: string; context?: string } = { from: edge.from };
        if (edge.label) {
          result.context = edge.label;
        }
        return result;
      });

    return {
      path: normalizedPath,
      backlinks
    };
  }

  /**
   * Get outlinks from a specific note
   */
  async getOutlinks(path: string): Promise<OutlinksResult> {
    const notes = await this.getAllNotes();
    const noteSet = new Set(notes);

    // Normalize and find the actual path
    const normalizedPath = path.endsWith('.md') ? path : `${path}.md`;

    // Find the actual file
    let actualPath = normalizedPath;
    if (!noteSet.has(normalizedPath)) {
      for (const note of notes) {
        if (note.endsWith(normalizedPath) || note.toLowerCase() === normalizedPath.toLowerCase()) {
          actualPath = note;
          break;
        }
      }
    }

    const fullPath = join(this.vaultPath, actualPath);
    const sourceDir = actualPath.includes('/') ? actualPath.substring(0, actualPath.lastIndexOf('/')) : '';

    try {
      const content = await readFile(fullPath, 'utf-8');
      const links = this.extractLinks(content);

      const outlinks = links.map(link => {
        const resolved = this.resolveLink(link.target, noteSet, sourceDir);
        const result: { to: string; resolved: boolean; alias?: string } = {
          to: resolved || link.target,
          resolved: resolved !== null
        };
        if (link.alias) {
          result.alias = link.alias;
        }
        return result;
      });

      return {
        path: actualPath,
        outlinks
      };
    } catch {
      return {
        path: actualPath,
        outlinks: []
      };
    }
  }

  /**
   * Get a local subgraph around a specific note
   */
  async getLocalGraph(params: LocalGraphParams): Promise<Graph> {
    const { path, depth = 1 } = params;
    const fullGraph = await this.getGraph();

    // Normalize path
    const normalizedPath = path.endsWith('.md') ? path : `${path}.md`;

    // Find the actual node
    let centerNode = fullGraph.nodes.find(n => n.id === normalizedPath);
    if (!centerNode) {
      centerNode = fullGraph.nodes.find(n =>
        n.id.endsWith(normalizedPath) ||
        n.id.toLowerCase() === normalizedPath.toLowerCase()
      );
    }

    if (!centerNode) {
      return { nodes: [], edges: [] };
    }

    // BFS to find all nodes within depth
    const includedNodes = new Set<string>([centerNode.id]);
    const queue: Array<{ id: string; currentDepth: number }> = [{ id: centerNode.id, currentDepth: 0 }];

    while (queue.length > 0) {
      const current = queue.shift()!;
      const { id, currentDepth } = current;

      if (currentDepth >= depth) continue;

      // Find connected nodes
      for (const edge of fullGraph.edges) {
        if (edge.from === id && !includedNodes.has(edge.to)) {
          includedNodes.add(edge.to);
          queue.push({ id: edge.to, currentDepth: currentDepth + 1 });
        }
        if (edge.to === id && !includedNodes.has(edge.from)) {
          includedNodes.add(edge.from);
          queue.push({ id: edge.from, currentDepth: currentDepth + 1 });
        }
      }
    }

    // Filter nodes and edges
    const localNodes = fullGraph.nodes.filter(n => includedNodes.has(n.id));
    const localEdges = fullGraph.edges.filter(e =>
      includedNodes.has(e.from) && includedNodes.has(e.to)
    );

    return {
      nodes: localNodes,
      edges: localEdges
    };
  }
}
