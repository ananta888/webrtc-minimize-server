import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TODOS = path.join(ROOT, "todos");
const STATUS_KEYS = ["todo", "in_progress", "partial", "blocked", "done"];

async function readJson(file) {
  return JSON.parse(await fs.readFile(file, "utf8"));
}

async function todoFiles(directory) {
  const result = [];
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) result.push(...await todoFiles(absolute));
    else if (entry.name.endsWith(".json") && !entry.name.endsWith("schema.json")) result.push(absolute);
  }
  return result.sort();
}

function sameRecord(actual, expected) {
  return Object.keys(expected).every((key) => actual?.[key] === expected[key]);
}

function validateTrackSemantics(document, relative) {
  const errors = [];
  const ids = new Set();
  for (const task of document.tasks) {
    if (ids.has(task.id)) errors.push(`duplicate task id ${task.id}`);
    ids.add(task.id);
    const progress = task.progress_percent;
    if (task.status === "done" && progress !== undefined && progress !== 100) errors.push(`${task.id}: done requires progress_percent=100`);
    if (task.status === "todo" && progress !== undefined && progress !== 0) errors.push(`${task.id}: todo requires progress_percent=0`);
    if (["in_progress", "partial"].includes(task.status) && (progress === undefined || progress < 1 || progress > 99)) {
      errors.push(`${task.id}: ${task.status} requires progress_percent 1..99`);
    }
  }
  for (const task of document.tasks) {
    for (const dependency of task.depends_on || []) if (!ids.has(dependency)) errors.push(`${task.id}: unknown dependency ${dependency}`);
  }
  for (const milestone of document.milestones) {
    for (const taskId of milestone.task_ids) if (!ids.has(taskId)) errors.push(`${milestone.id}: unknown task ${taskId}`);
  }
  const byStatus = Object.fromEntries(STATUS_KEYS.map((status) => [status, document.tasks.filter((task) => task.status === status).length]));
  const byPriority = Object.fromEntries(document.priority_scale.map((priority) => [priority, document.tasks.filter((task) => task.priority === priority).length]));
  const byRisk = Object.fromEntries(document.risk_scale.map((risk) => [risk, document.tasks.filter((task) => task.risk === risk).length]));
  const critical = document.critical_path_tasks || [];
  const milestoneCounts = { total: document.milestones.length, todo: 0, in_progress: 0, blocked: 0, done: 0 };
  for (const milestone of document.milestones) milestoneCounts[milestone.status] += 1;
  const summary = document.tasks_status_summary;
  const expected = {
    total: document.tasks.length,
    progress_percent_done: document.tasks.length ? Number(((byStatus.done / document.tasks.length) * 100).toFixed(2)) : 0,
  };
  if (!sameRecord(summary, expected)) errors.push("tasks_status_summary totals do not match tasks[]");
  if (!sameRecord(summary.by_status, byStatus)) errors.push("tasks_status_summary.by_status does not match tasks[]");
  if (!sameRecord(summary.by_priority, byPriority)) errors.push("tasks_status_summary.by_priority does not match tasks[]");
  if (!sameRecord(summary.by_risk, byRisk)) errors.push("tasks_status_summary.by_risk does not match tasks[]");
  const criticalDone = critical.filter((id) => document.tasks.find((task) => task.id === id)?.status === "done").length;
  if (!sameRecord(summary.critical_path, { total: critical.length, done: criticalDone, remaining: critical.length - criticalDone })) {
    errors.push("tasks_status_summary.critical_path does not match tasks[]");
  }
  if (!sameRecord(summary.milestones, milestoneCounts)) errors.push("tasks_status_summary.milestones does not match milestones[]");
  if (errors.length) throw new Error(`${relative}:\n  ${errors.join("\n  ")}`);
}

function validateCategorySemantics(document, relative) {
  const items = document.categories.flatMap((category) => category.items);
  const ids = items.map((item) => item.id);
  if (new Set(ids).size !== ids.length) throw new Error(`${relative}: duplicate category item id`);
  const completed = items.filter((item) => item.status === "completed").length;
  const partial = items.filter((item) => item.status === "partial").length;
  const open = items.filter((item) => !["completed", "partial"].includes(item.status)).length;
  if (document.meta.total_items !== items.length || !sameRecord(document.meta.by_status, { completed, partial, open })) {
    throw new Error(`${relative}: meta summary does not match categories[].items[]`);
  }
}

const ajv = new Ajv2020({ allErrors: true, strict: true });
const categorySchema = await readJson(path.join(TODOS, "todo.schema.json"));
const trackSchema = await readJson(path.join(TODOS, "todo.track.schema.json"));
const validateCategory = ajv.compile(categorySchema);
const validateTrack = ajv.compile(trackSchema);
const files = await todoFiles(TODOS);
for (const file of files) {
  const document = await readJson(file);
  const relative = path.relative(ROOT, file);
  const isCategory = Array.isArray(document.categories);
  const validate = isCategory ? validateCategory : validateTrack;
  if (!validate(document)) {
    throw new Error(`${relative}: ${ajv.errorsText(validate.errors, { separator: "\n  " })}`);
  }
  if (isCategory) validateCategorySemantics(document, relative);
  else validateTrackSemantics(document, relative);
}
console.log(`Validated ${files.length} todo documents.`);
