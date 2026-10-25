import { describe, expect, test } from 'bun:test';
import { PathFinder } from '../game/map/pathFinder/PathFinder';
import { Graph } from '../util/Graph';

function connectedTiles() {
    const graph = new Graph<{ x: number }>();
    const start = graph.addNode('60_90', { x: 60 });
    const target = graph.addNode('61_90', { x: 61 });
    start.addLink(target);
    return { graph, start, target };
}

describe('PathFinder unavailable terrain endpoints', () => {
    test('a destination removed from the passability graph is unreachable', () => {
        const { graph } = connectedTiles();
        const finder = new PathFinder(graph);
        expect(finder.find('60_90', '61_90').map(node => node.id)).toEqual(['61_90', '60_90']);
        graph.removeNode('61_90');
        expect(finder.find('60_90', '61_90')).toEqual([]);
    });

    test('best effort cannot invent a missing destination or source', () => {
        const { graph } = connectedTiles();
        const finder = new PathFinder(graph, { bestEffort: true });
        expect(finder.find('60_90', 'missing')).toEqual([]);
        expect(finder.find('missing', '61_90')).toEqual([]);
        expect(finder.find('missing', 'missing')).toEqual([]);
        expect(finder.find('60_90', '61_90').map(node => node.id)).toEqual(['61_90', '60_90']);
    });

    test('a subsequent search succeeds after terrain restores the destination', () => {
        const { graph, start } = connectedTiles();
        const finder = new PathFinder(graph);
        graph.removeNode('61_90');
        expect(finder.find('60_90', '61_90')).toEqual([]);
        start.addLink(graph.addNode('61_90', { x: 61 }));
        expect(finder.find('60_90', '61_90').map(node => node.id)).toEqual(['61_90', '60_90']);
    });

    test('existing disconnected endpoints remain unreachable', () => {
        const { graph, start, target } = connectedTiles();
        start.removeLink(target);
        expect(new PathFinder(graph).find('60_90', '61_90')).toEqual([]);
    });
});
