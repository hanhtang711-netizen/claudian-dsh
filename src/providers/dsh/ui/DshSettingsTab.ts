import * as fs from 'fs';
import { Setting } from 'obsidian';

import { ProviderSettingsCoordinator } from '../../../core/providers/ProviderSettingsCoordinator';
import type {
  ProviderSettingsTabRenderer,
} from '../../../core/providers/types';
import { renderEnvironmentSettingsSection } from '../../../shared/settings/EnvironmentSettingsSection';
import { renderHostnameCliPathSetting } from '../../../shared/settings/HostnameCliPathSetting';
import { renderLastEnabledProviderWarning } from '../../../shared/settings/ProviderModelEnablementWarning';
import { renderProviderEnablementSetting } from '../../../shared/settings/ProviderEnablementSetting';
import { getHostnameKey } from '../../../utils/env';
import { expandHomePath } from '../../../utils/path';
import {
  getDshProviderSettings,
  updateDshProviderSettings,
} from '../settings';

export const dshSettingsTabRenderer: ProviderSettingsTabRenderer = {
  render(container, context) {
    const settingsBag = context.plugin.settings as unknown as Record<string, unknown>;
    const hostnameKey = getHostnameKey();

    new Setting(container).setName('Setup').setHeading();

    const lastProviderWarning = renderLastEnabledProviderWarning(container);

    renderProviderEnablementSetting({
      container,
      description: 'Run DeepSeek Harness sessions inside Claudian.',
      getValue: () => getDshProviderSettings(settingsBag).enabled,
      name: 'Enable DeepSeek Harness',
      onChange: async (value) => {
        if (!ProviderSettingsCoordinator.canApplyProviderEnablement(
          settingsBag,
          'dsh',
          value,
        )) {
          lastProviderWarning.showFor();
          return;
        }

        await context.plugin.runProviderExecutionTransition(['dsh'], async () => {
          await context.plugin.mutateSettings((settings) => {
            ProviderSettingsCoordinator.applyProviderEnablement(
              settings,
              'dsh',
              value,
            );
          });
        });
        lastProviderWarning.hide();
      },
    });

    renderHostnameCliPathSetting({
      container,
      description: 'Optional absolute path to the dsh CLI for this computer. Leave empty to use `dsh` from PATH.',
      getValue: () => getDshProviderSettings(settingsBag).cliPathsByHost[hostnameKey] || '',
      name: 'CLI path',
      onChange: async (value) => {
        const cliPathsByHost = {
          ...getDshProviderSettings(settingsBag).cliPathsByHost,
        };
        if (value) {
          cliPathsByHost[hostnameKey] = value;
        } else {
          delete cliPathsByHost[hostnameKey];
        }

        await context.plugin.applyProviderRuntimeSettings(
          ['dsh'],
          (settings) => {
            updateDshProviderSettings(settings, { cliPathsByHost });
          },
        );
      },
      placeholder: process.platform === 'win32'
        ? 'C:\\Users\\you\\AppData\\Roaming\\npm\\dsh.cmd'
        : '/opt/homebrew/bin/dsh',
      validate: validateCliPath,
    });

    renderEnvironmentSettingsSection({
      container,
      plugin: context.plugin,
      scope: 'provider:dsh',
      heading: 'Environment',
      name: 'Environment Variables',
      desc: 'Extra environment variables passed to the DeepSeek Harness bridge. Usually left empty.',
      placeholder: 'DSH_HOME=/custom/home',
      renderCustomContextLimits: (target) => context.renderCustomContextLimits(target, 'dsh'),
    });
  },
};

function validateCliPath(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }

  const expandedPath = expandHomePath(trimmed);
  if (!fs.existsSync(expandedPath)) {
    return 'Path does not exist';
  }
  if (!fs.statSync(expandedPath).isFile()) {
    return 'Path must point to a file';
  }
  return null;
}
