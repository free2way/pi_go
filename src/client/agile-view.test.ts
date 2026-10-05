import { describe, expect, it } from "vitest";
import type { AgileStory } from "../shared/agile";
import { columnPoints, estimateLabel, groupStoriesByColumn, priorityLabel, splitLines, storyReference } from "./agile-view";

function story(overrides: Partial<AgileStory>): AgileStory {
  return {
    id: `story_${Math.random().toString(36).slice(2)}`,
    projectId: "proj_1",
    ownerId: "user_a",
    title: "故事",
    description: "",
    acceptanceCriteria: [],
    priority: "should",
    estimate: null,
    definitionOfDone: [],
    developerModel: null,
    reviewerModel: null,
    budget: null,
    maxParallel: null,
    status: "backlog",
    sprintId: null,
    workspaceId: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("groupStoriesByColumn", () => {
  it("buckets stories into the six fixed columns, folding backlog+ready into 待办", () => {
    const groups = groupStoriesByColumn([
      story({ status: "backlog" }),
      story({ status: "ready" }),
      story({ status: "in_progress" }),
      story({ status: "in_review" }),
      story({ status: "awaiting_acceptance" }),
      story({ status: "done" }),
      story({ status: "blocked" }),
    ]);
    expect(groups.map((group) => group.label)).toEqual(["待办", "开发中", "审核中", "待验收", "完成", "阻塞"]);
    expect(groups.map((group) => group.stories.length)).toEqual([2, 1, 1, 1, 1, 1]);
  });

  it("sums the estimates per column", () => {
    const groups = groupStoriesByColumn([story({ status: "ready", estimate: 3 }), story({ status: "ready", estimate: 5 })]);
    expect(columnPoints(groups[0])).toBe(8);
    expect(columnPoints(groups[1])).toBe(0);
  });
});

describe("agile view helpers", () => {
  it("splits textarea lines and drops blanks", () => {
    expect(splitLines("a\n\n  b  \nc")).toEqual(["a", "b", "c"]);
  });

  it("labels priorities and estimates, including the unestimated case", () => {
    expect(priorityLabel("must")).toBe("必须");
    expect(estimateLabel(5)).toContain("5 点");
    expect(estimateLabel(null)).toBe("未估算");
  });

  it("builds a story reference from the project key and 1-based index", () => {
    expect(storyReference("AUTH", 0)).toBe("AUTH-1");
    expect(storyReference("AUTH", 11)).toBe("AUTH-12");
  });
});
