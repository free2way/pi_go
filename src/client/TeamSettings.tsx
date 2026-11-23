import { ArrowDown, ArrowUp, LoaderCircle, Pencil, Plus, Save, Trash2, Users, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { AgentProfile, AgentProfileRole, AgentTeam, ModelCatalogResponse } from "../shared/types";
import { localizeError } from "../shared/i18n";
import { api } from "./api";
import { useT } from "./i18n";

const roles: AgentProfileRole[] = ["planner", "developer", "integrator", "reviewer", "custom"];

export function teamProfileIssue(profiles: readonly AgentProfile[]): "missing" | "duplicate" | undefined {
  const roleSet = new Set(profiles.map((profile) => profile.role));
  if (!roleSet.has("developer") || !roleSet.has("reviewer")) return "missing";
  if (roleSet.size !== profiles.length) return "duplicate";
  return undefined;
}

function modelValue(profile: Pick<AgentProfile, "provider" | "model">) {
  return `${profile.provider}::${profile.model}`;
}

export function TeamSettings({ catalog, onChanged }: { catalog?: ModelCatalogResponse; onChanged: () => void }) {
  const { t, locale } = useT();
  const [profiles, setProfiles] = useState<AgentProfile[]>([]);
  const [teams, setTeams] = useState<AgentTeam[]>([]);
  const [profileId, setProfileId] = useState("");
  const [profileName, setProfileName] = useState("");
  const [profileRole, setProfileRole] = useState<AgentProfileRole>("developer");
  const [profileModel, setProfileModel] = useState("");
  const [teamId, setTeamId] = useState("");
  const [teamName, setTeamName] = useState("");
  const [teamMembers, setTeamMembers] = useState<string[]>([]);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      const [profileResult, teamResult] = await Promise.all([api.agentProfiles(), api.agentTeams()]);
      setProfiles(profileResult.profiles);
      setTeams(teamResult.teams);
      setError("");
    } catch (cause) {
      setError(localizeError(locale, cause as { code?: string; message?: string }));
    } finally {
      setLoading(false);
    }
  }, [locale]);

  useEffect(() => { void load(); }, [load]);

  const modelOptions = useMemo(() => (catalog?.models ?? []).filter((entry) => entry.roles.includes(profileRole)), [catalog, profileRole]);
  useEffect(() => {
    if (!modelOptions.some((entry) => entry.available && `${entry.provider}::${entry.model}` === profileModel)) {
      const first = modelOptions.find((entry) => entry.available);
      setProfileModel(first ? `${first.provider}::${first.model}` : "");
    }
  }, [modelOptions, profileModel]);

  const resetProfile = () => { setProfileId(""); setProfileName(""); setProfileRole("developer"); setProfileModel(""); };
  const resetTeam = () => { setTeamId(""); setTeamName(""); setTeamMembers([]); };
  const moveMember = (id: string, direction: -1 | 1) => {
    setTeamMembers((current) => {
      const index = current.indexOf(id);
      const target = index + direction;
      if (index < 0 || target < 0 || target >= current.length) return current;
      const next = [...current];
      [next[index], next[target]] = [next[target], next[index]];
      return next;
    });
  };
  const saveProfile = async () => {
    const separator = profileModel.indexOf("::");
    if (!profileName.trim() || separator < 1) return;
    setBusy("profile"); setError("");
    const input = { name: profileName.trim(), role: profileRole, provider: profileModel.slice(0, separator), model: profileModel.slice(separator + 2) };
    try {
      if (profileId) await api.updateAgentProfile(profileId, input);
      else await api.createAgentProfile(input);
      resetProfile(); await load(); onChanged();
    } catch (cause) { setError(localizeError(locale, cause as { code?: string; message?: string })); }
    finally { setBusy(""); }
  };
  const saveTeam = async () => {
    const selected = teamMembers.map((id) => profiles.find((profile) => profile.id === id)).filter((profile): profile is AgentProfile => Boolean(profile));
    const issue = teamProfileIssue(selected);
    if (!teamName.trim() || issue) { setError(t(issue === "duplicate" ? "teams.errorDuplicate" : "teams.errorMissing")); return; }
    setBusy("team"); setError("");
    try {
      const input = { name: teamName.trim(), profileIds: teamMembers };
      if (teamId) await api.updateAgentTeam(teamId, input);
      else await api.createAgentTeam(input);
      resetTeam(); await load(); onChanged();
    } catch (cause) { setError(localizeError(locale, cause as { code?: string; message?: string })); }
    finally { setBusy(""); }
  };

  return (
    <section className="team-settings" aria-labelledby="team-settings-title">
      <div className="team-settings-head">
        <div><span className="eyebrow">MULTI-AGENT TEAMS</span><h2 id="team-settings-title">{t("teams.title")}</h2><p>{t("teams.subtitle")}</p></div>
        {loading && <LoaderCircle className="spin" size={18} />}
      </div>
      {error && <div className="form-error">{error}</div>}
      <div className="team-settings-columns">
        <div className="team-settings-column">
          <div className="team-section-title"><div><h3>{t("teams.profiles")}</h3><p>{t("teams.profilesHint")}</p></div><span>{profiles.length}</span></div>
          <div className="team-form-grid">
            <label>{t("teams.profileName")}<input value={profileName} onChange={(event) => setProfileName(event.target.value)} /></label>
            <label>{t("teams.role")}<select value={profileRole} onChange={(event) => setProfileRole(event.target.value as AgentProfileRole)}>{roles.map((role) => <option key={role} value={role}>{t(`role.${role}`)}</option>)}</select></label>
            <label className="team-form-wide">{t("teams.model")}<select value={profileModel} onChange={(event) => setProfileModel(event.target.value)}>{modelOptions.map((entry) => <option key={entry.id} value={`${entry.provider}::${entry.model}`} disabled={!entry.available}>{entry.label} · {entry.provider}/{entry.model}{entry.available ? "" : ` · ${t("teams.modelUnavailable")}`}</option>)}</select></label>
            <div className="team-form-actions"><button type="button" className="button primary" disabled={busy === "profile" || !profileName.trim() || !profileModel} onClick={() => void saveProfile()}>{busy === "profile" ? <LoaderCircle className="spin" size={14} /> : <Save size={14} />}{t(profileId ? "teams.updateProfile" : "teams.addProfile")}</button>{profileId && <button type="button" className="button secondary" onClick={resetProfile}><X size={14} />{t("common.cancel")}</button>}</div>
          </div>
          <div className="team-rows">
            {profiles.map((profile) => <div className="team-row" key={profile.id}><div><strong>{profile.name}</strong><span>{t(`role.${profile.role}`)} · {profile.provider}/{profile.model}</span></div><div className="team-row-actions"><button type="button" className="icon-button" aria-label={t("teams.editProfile")} onClick={() => { setProfileId(profile.id); setProfileName(profile.name); setProfileRole(profile.role); setProfileModel(modelValue(profile)); }}><Pencil size={14} /></button><button type="button" className="icon-button danger" aria-label={t("teams.deleteProfile")} onClick={() => { if (!window.confirm(t("teams.deleteProfileConfirm", { name: profile.name }))) return; setBusy(profile.id); void api.deleteAgentProfile(profile.id).then(load).then(onChanged).catch((cause) => setError(localizeError(locale, cause))).finally(() => setBusy("")); }} disabled={busy === profile.id}><Trash2 size={14} /></button></div></div>)}
            {!loading && profiles.length === 0 && <div className="team-empty">{t("teams.noProfiles")}</div>}
          </div>
        </div>
        <div className="team-settings-column">
          <div className="team-section-title"><div><h3>{t("teams.teams")}</h3><p>{t("teams.teamsHint")}</p></div><span>{teams.length}</span></div>
          <div className="team-form-grid">
            <label className="team-form-wide">{t("teams.teamName")}<input value={teamName} onChange={(event) => setTeamName(event.target.value)} /></label>
            <div className="team-member-picker team-form-wide">{profiles.map((profile) => { const selected = teamMembers.includes(profile.id); const sameRole = profiles.some((item) => item.id !== profile.id && teamMembers.includes(item.id) && item.role === profile.role); return <label className={selected ? "selected" : ""} key={profile.id}><input type="checkbox" checked={selected} disabled={!selected && sameRole} onChange={() => setTeamMembers((current) => selected ? current.filter((id) => id !== profile.id) : [...current, profile.id])} /><span><strong>{profile.name}</strong><small>{t(`role.${profile.role}`)} · {profile.provider}/{profile.model}</small></span></label>; })}</div>
            {teamMembers.length > 0 && <ol className="team-member-order team-form-wide" aria-label={t("teams.memberOrder")}>
              {teamMembers.map((id, index) => { const profile = profiles.find((item) => item.id === id); return profile ? <li key={id}><span><b>{String(index + 1).padStart(2, "0")}</b><strong>{profile.name}</strong><small>{t(`role.${profile.role}`)}</small></span><div><button type="button" className="icon-button" aria-label={t("teams.moveUp", { name: profile.name })} disabled={index === 0} onClick={() => moveMember(id, -1)}><ArrowUp size={13} /></button><button type="button" className="icon-button" aria-label={t("teams.moveDown", { name: profile.name })} disabled={index === teamMembers.length - 1} onClick={() => moveMember(id, 1)}><ArrowDown size={13} /></button></div></li> : null; })}
            </ol>}
            <div className="team-form-actions"><button type="button" className="button primary" disabled={busy === "team" || !teamName.trim() || teamMembers.length === 0} onClick={() => void saveTeam()}>{busy === "team" ? <LoaderCircle className="spin" size={14} /> : teamId ? <Save size={14} /> : <Plus size={14} />}{t(teamId ? "teams.updateTeam" : "teams.createTeam")}</button>{teamId && <button type="button" className="button secondary" onClick={resetTeam}><X size={14} />{t("common.cancel")}</button>}</div>
          </div>
          <div className="team-rows">
            {teams.map((team) => <div className="team-row team-row-stacked" key={team.id}><div className="team-row-main"><Users size={15} /><div><strong>{team.name}</strong><span>{team.profiles.map((profile) => `${t(`role.${profile.role}`)} · ${profile.name}`).join(" · ")}</span></div></div><div className="team-row-actions"><button type="button" className="icon-button" aria-label={t("teams.editTeam")} onClick={() => { setTeamId(team.id); setTeamName(team.name); setTeamMembers(team.profiles.map((profile) => profile.id)); }}><Pencil size={14} /></button><button type="button" className="icon-button danger" aria-label={t("teams.deleteTeam")} onClick={() => { if (!window.confirm(t("teams.deleteTeamConfirm", { name: team.name }))) return; setBusy(team.id); void api.deleteAgentTeam(team.id).then(load).then(onChanged).catch((cause) => setError(localizeError(locale, cause))).finally(() => setBusy("")); }} disabled={busy === team.id}><Trash2 size={14} /></button></div></div>)}
            {!loading && teams.length === 0 && <div className="team-empty">{t("teams.noTeams")}</div>}
          </div>
        </div>
      </div>
    </section>
  );
}
