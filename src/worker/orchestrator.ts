import type { DevelopmentPlan, SubAgentTask, WorkloadSize } from "../shared/types.js";

const complexityValues = new Set<WorkloadSize>(["small", "medium", "large"]);

function cleanJson(text: string) {
  return text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
}

function normalizeId(value: unknown, index: number) {
  const candidate = String(value || `task-${index + 1}`).toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "");
  return candidate.slice(0, 32) || `task-${index + 1}`;
}

export function parseDevelopmentPlan(text: string, maxSubagents: number): DevelopmentPlan {
  const parsed = JSON.parse(cleanJson(text)) as Record<string, unknown>;
  const rawTasks = Array.isArray(parsed.tasks) ? parsed.tasks : [];
  if (rawTasks.length === 0) throw new Error("Planner returned no tasks");

  const tasks: SubAgentTask[] = rawTasks.slice(0, maxSubagents).map((raw, index) => {
    const item = raw as Record<string, unknown>;
    return {
      id: normalizeId(item.id, index),
      title: String(item.title || `Task ${index + 1}`).slice(0, 120),
      description: String(item.description || item.title || "Implement the assigned part.").slice(0, 4_000),
      files: Array.isArray(item.files) ? item.files.map(String).filter((file) => !file.includes("..") && !file.startsWith("/")).slice(0, 30) : [],
      dependsOn: Array.isArray(item.dependsOn) ? item.dependsOn.map(String).slice(0, maxSubagents) : [],
      status: "planned",
    };
  });

  const ids = new Set<string>();
  for (const [index, task] of tasks.entries()) {
    while (ids.has(task.id)) task.id = `${task.id}-${index + 1}`.slice(0, 32);
    ids.add(task.id);
  }
  for (const task of tasks) task.dependsOn = task.dependsOn.filter((id) => ids.has(id) && id !== task.id);

  const complexity = complexityValues.has(parsed.complexity as WorkloadSize) ? parsed.complexity as WorkloadSize : tasks.length === 1 ? "small" : "medium";
  return {
    complexity,
    rationale: String(parsed.rationale || "Planner did not provide a rationale.").slice(0, 1_000),
    strategy: tasks.length === 1 ? "single" : "parallel",
    tasks,
  };
}

export function executionWaves(tasks: SubAgentTask[]) {
  const pending = new Map(tasks.map((task) => [task.id, task]));
  const completed = new Set<string>();
  const waves: SubAgentTask[][] = [];
  while (pending.size > 0) {
    const ready = [...pending.values()].filter((task) => task.dependsOn.every((id) => completed.has(id)));
    if (ready.length === 0) throw new Error("Planner returned cyclic task dependencies");
    waves.push(ready);
    for (const task of ready) {
      pending.delete(task.id);
      completed.add(task.id);
    }
  }
  return waves;
}

export function fallbackPlan(task: string): DevelopmentPlan {
  return {
    complexity: "small",
    rationale: "Planner output was unavailable, so execution safely falls back to one developer agent.",
    strategy: "single",
    tasks: [{
      id: "implementation",
      title: "Complete implementation",
      description: task,
      files: [],
      dependsOn: [],
      status: "planned",
    }],
  };
}
