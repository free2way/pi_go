import { FolderCog, BarChart3, LayoutTemplate, Pencil, Plus, Rocket } from "lucide-react";
import type { ConfigStatus } from "../shared/types";
import { useAgilePage } from "./useAgilePage";
import { AgilePlanningForms } from "./AgilePlanningForms";
import { AgileBoard } from "./AgileBoard";
import { AgileInsights } from "./AgileInsights";
import { AgileReleasePanels } from "./AgileReleasePanels";
import { AgileStoryDetail } from "./AgileStoryDetail";

/** Sprint 3 batch 1: project/story planning on top of the existing run engine. */
export function AgilePage({ config, onOpenRun }: { config?: ConfigStatus; onOpenRun: (runId: string) => void }) {
  const state = useAgilePage(config);
  const {
    t, panel, setPanel, setError, setNotice, setConfirmDeleteId, projectId, resetSprintForm,
    resetStoryForm, releases,
  } = state.header;

  return (
    <div className="workspaces-page">
      <section className="ws-heading">
        <div>
          <span className="eyebrow">AGILE PLANNING</span>
          <h1>{t("nav.agile")}</h1>
          <p>{t("agile.subtitle")}</p>
        </div>
        <div className="ws-heading-actions">
          <button className={`button secondary ${panel === "manage" ? "active" : ""}`} onClick={() => { setPanel(panel === "manage" ? "none" : "manage"); setError(""); setNotice(""); setConfirmDeleteId(""); }}><FolderCog size={15} />{t("agile.manageProjects")}</button>
          <button className="button secondary" onClick={() => { setPanel(panel === "project" ? "none" : "project"); setError(""); }}><Plus size={15} />{t("agile.newProject")}</button>
          <button className="button secondary" disabled={!projectId} onClick={() => { if (panel === "sprint") { setPanel("none"); } else { resetSprintForm(); setPanel("sprint"); setError(""); } }}><Plus size={15} />{t("agile.newSprint")}</button>
          <button className="button secondary" disabled={!projectId} onClick={() => { if (panel === "story") { setPanel("none"); } else { resetStoryForm(); setPanel("story"); setError(""); } }}><Plus size={15} />{t("agile.newStory")}</button>
          <button className={`button secondary ${panel === "templates" ? "active" : ""}`} onClick={() => { setPanel(panel === "templates" ? "none" : "templates"); setError(""); }}><LayoutTemplate size={15} />{t("agile.templates")}</button>
          <button className={`button secondary ${panel === "metrics" ? "active" : ""}`} disabled={!projectId} onClick={() => { setPanel(panel === "metrics" ? "none" : "metrics"); setError(""); }}><BarChart3 size={15} />{t("agile.metrics")}</button>
          <button className={`button secondary ${panel === "release" ? "active" : ""}`} disabled={!projectId || releases.length === 0} onClick={() => { setPanel(panel === "release" ? "none" : "release"); setError(""); }}><Rocket size={15} />{t("agile.releaseReview")}</button>
          <button className={`button secondary ${panel === "releases" ? "active" : ""}`} disabled={!projectId} onClick={() => { setPanel(panel === "releases" ? "none" : "releases"); setError(""); }}><Pencil size={15} />{t("agile.releaseManage")}</button>
        </div>
      </section>

      <AgilePlanningForms state={state.forms} />
      <AgileBoard state={state.board} />
      <AgileInsights state={state.insights} />
      <AgileReleasePanels state={state.releases} />
      <AgileStoryDetail state={state.detail} config={config} onOpenRun={onOpenRun} />
    </div>
  );
}
