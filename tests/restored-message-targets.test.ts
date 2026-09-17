import { describe, expect, it } from 'vitest';
import {
  getRestoredMessageMutationAction,
  mutationMayAffectRestoredMessageTarget,
} from '../entrypoints/content/restored-message-targets';

describe('restored message target mutations', () => {
  it('detects newly mounted messages and content added inside an existing message', () => {
    const message = document.createElement('article');
    message.className = 'ds-message';
    const content = document.createElement('div');
    message.appendChild(content);

    expect(mutationMayAffectRestoredMessageTarget(childListMutation(document.body, message)))
      .toBe(true);
    expect(mutationMayAffectRestoredMessageTarget(childListMutation(message, content)))
      .toBe(true);
  });

  it('detects late text rendering inside a message', () => {
    const message = document.createElement('article');
    message.className = 'ds-message';
    const text = document.createTextNode('Late assistant content');
    message.appendChild(text);

    expect(mutationMayAffectRestoredMessageTarget(characterDataMutation(text))).toBe(true);
  });

  it('ignores extension-owned restored UI so rendering does not reschedule itself', () => {
    const message = document.createElement('article');
    message.className = 'ds-message';
    const artifactResults = document.createElement('div');
    artifactResults.className = 'dpp-artifact-results';
    const artifactItem = document.createElement('span');
    artifactResults.appendChild(artifactItem);
    message.appendChild(artifactResults);

    expect(mutationMayAffectRestoredMessageTarget(childListMutation(message, artifactResults)))
      .toBe(false);
    expect(mutationMayAffectRestoredMessageTarget(childListMutation(artifactResults, artifactItem)))
      .toBe(false);
  });

  it('does not schedule a full restore for ordinary streaming text after pending records finish', () => {
    const message = document.createElement('article');
    message.className = 'ds-message';
    const text = document.createTextNode('Streaming assistant content');
    message.appendChild(text);

    expect(getRestoredMessageMutationAction([characterDataMutation(text)], {
      hasPendingRecords: false,
      restoredUiSelector: '.dpp-artifact-results',
    })).toEqual({
      requeueMountedRecords: false,
      schedulePendingRender: false,
    });
    expect(getRestoredMessageMutationAction([characterDataMutation(text)], {
      hasPendingRecords: true,
      restoredUiSelector: '.dpp-artifact-results',
    })).toEqual({
      requeueMountedRecords: false,
      schedulePendingRender: true,
    });
  });

  it('requeues records when a message remounts or restored UI is removed', () => {
    const message = document.createElement('article');
    message.className = 'ds-message';
    const artifactResults = document.createElement('div');
    artifactResults.className = 'dpp-artifact-results';

    expect(getRestoredMessageMutationAction([childListMutation(document.body, message)], {
      hasPendingRecords: false,
      restoredUiSelector: '.dpp-artifact-results',
    })).toEqual({
      requeueMountedRecords: true,
      schedulePendingRender: true,
    });
    expect(getRestoredMessageMutationAction([childListMutation(message, [], [artifactResults])], {
      hasPendingRecords: false,
      restoredUiSelector: '.dpp-artifact-results',
    })).toEqual({
      requeueMountedRecords: true,
      schedulePendingRender: true,
    });
  });
});

function childListMutation(
  target: Node,
  addedNodesOrFirstNode: Node[] | Node,
  removedNodes: Node[] = [],
): MutationRecord {
  const addedNodes = Array.isArray(addedNodesOrFirstNode)
    ? addedNodesOrFirstNode
    : [addedNodesOrFirstNode];
  return {
    type: 'childList',
    target,
    addedNodes: addedNodes as unknown as NodeList,
    removedNodes: removedNodes as unknown as NodeList,
  } as MutationRecord;
}

function characterDataMutation(target: Node): MutationRecord {
  return { type: 'characterData', target } as MutationRecord;
}
