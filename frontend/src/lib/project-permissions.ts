// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
// This uses the default i18next instance (the one `@/i18n` initializes). `@/i18n` itself is not imported,
// because that module also pulls in react-i18next / HttpBackend, and putting it into this widely imported low-level
// chain would make every test that mocks react-i18next blow up at import time.
import i18n from "i18next";

import { isCeRuntime } from "@/lib/runtime-config";
import type { ProjectRole, ProjectSummary } from "@/types/project";

const ROLE_RANK: Record<ProjectRole, number> = {
  viewer: 10,
  editor: 20,
  admin: 30,
  owner: 40,
};

export function projectRole(summary: ProjectSummary): ProjectRole {
  return summary.effectiveRole ?? "owner";
}

export function roleAllows(actual: ProjectRole | undefined, required: ProjectRole): boolean {
  return ROLE_RANK[actual ?? "viewer"] >= ROLE_RANK[required];
}

export function canManageProjectGrants(summary: ProjectSummary): boolean {
  // CE has no project sharing/grants concept (AllowAllProjectAccess always returns owner, so role gating would wrongly show
  // EE-only entry points). Edition gating uses the runtime isCeRuntime(), the same mechanism as credit-balance-badge.
  if (isCeRuntime()) return false;
  return roleAllows(projectRole(summary), "admin");
}

export function canDeleteProject(summary: ProjectSummary): boolean {
  return projectRole(summary) === "owner";
}

export function isSharedProject(summary: ProjectSummary): boolean {
  return projectRole(summary) !== "owner";
}

export function projectRoleLabel(role: ProjectRole | undefined): string {
  switch (role ?? "owner") {
    case "viewer":
      return i18n.t("project.role.viewer");
    case "editor":
      return i18n.t("project.role.editor");
    case "admin":
      return i18n.t("project.role.admin");
    case "owner":
      return i18n.t("project.role.owner");
  }
}

