import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { CLAUDIAN_STORAGE_PATH } from '../../../core/bootstrap/storagePaths';
import {
  buildSystemPrompt,
  computeSystemPromptKey,
  type SystemPromptSettings,
} from '../../../core/prompt/mainAgent';

export interface DshLaunchArtifacts {
  configPath: string;
  configContent: string;
  launchKey: string;
  systemPromptPath: string;
}

export interface PrepareDshLaunchArtifactsParams {
  artifactsSubdir?: string;
  settings?: SystemPromptSettings;
  systemPromptKey?: string;
  systemPromptText?: string;
  workspaceRoot: string;
}

/**
 * Writes the launch artifacts the DSH bridge expects under
 * `<vault>/.claudian/dsh/execution/<sessionInstanceId>/`:
 *
 * - `config.json`  = { version: 1, vaultPath, systemPromptPath }
 * - `system.md`    = the Claudian system prompt (same content builder opencode
 *                    uses for its system.md)
 *
 * The bridge is spawned with `--profile bridge --config <configPath>` and
 * resolves everything else (modes, models, thought levels, approval, history)
 * on its own.
 */
export async function prepareDshLaunchArtifacts(
  params: PrepareDshLaunchArtifactsParams,
): Promise<DshLaunchArtifacts> {
  const artifactsDir = path.join(
    params.workspaceRoot,
    CLAUDIAN_STORAGE_PATH,
    params.artifactsSubdir ?? 'dsh',
  );
  const systemPromptPath = path.join(artifactsDir, 'system.md');
  const configPath = path.join(artifactsDir, 'config.json');
  const systemPrompt = normalizeSystemPrompt(
    params.systemPromptText ?? buildSystemPrompt(requireSettings(params)),
  );
  const promptKey = params.systemPromptKey
    ?? (params.systemPromptText !== undefined
      ? params.systemPromptText
      : computeSystemPromptKey(requireSettings(params)));
  const configContent = `${JSON.stringify({
    systemPromptPath,
    vaultPath: params.workspaceRoot,
    version: 1,
  }, null, 2)}\n`;

  await fs.mkdir(artifactsDir, { recursive: true });
  await writeIfChanged(systemPromptPath, systemPrompt);
  await writeIfChanged(configPath, configContent);

  return {
    configPath,
    configContent,
    launchKey: [
      promptKey,
      configContent,
    ].join('::'),
    systemPromptPath,
  };
}

async function writeIfChanged(filePath: string, content: string): Promise<void> {
  try {
    const existing = await fs.readFile(filePath, 'utf-8');
    if (existing === content) {
      return;
    }
  } catch {
    // Missing file; write below.
  }

  await fs.writeFile(filePath, content, 'utf-8');
}

function normalizeSystemPrompt(systemPrompt: string): string {
  return systemPrompt.endsWith('\n') ? systemPrompt : `${systemPrompt}\n`;
}

function requireSettings(
  params: PrepareDshLaunchArtifactsParams,
): SystemPromptSettings {
  if (params.settings) {
    return params.settings;
  }

  throw new Error('prepareDshLaunchArtifacts requires settings when no systemPromptText is provided');
}
