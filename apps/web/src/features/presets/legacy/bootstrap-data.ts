import { cloneJson, type PresetDocument, type PresetRecord } from '../domain/preset';
import type { PresetService } from '../application/preset-service';

export interface LegacyPresetBootstrapData extends Record<string, unknown> {
  koboldai_settings: string[];
  koboldai_setting_names: string[];
  novelai_settings: string[];
  novelai_setting_names: string[];
  openai_settings: string[];
  openai_setting_names: string[];
  textgenerationwebui_presets: string[];
  textgenerationwebui_preset_names: string[];
  instruct: PresetDocument[];
  context: PresetDocument[];
  sysprompt: PresetDocument[];
  reasoning: PresetDocument[];
  themes: PresetDocument[];
  movingUIPresets: PresetDocument[];
  quickReplyPresets: PresetDocument[];
}

export interface LegacyPresetBootstrapDataProvider {
  getLegacyBootstrapData(): Promise<LegacyPresetBootstrapData>;
}

export class PresetLegacyBootstrapProvider implements LegacyPresetBootstrapDataProvider {
  readonly #presets: PresetService;

  constructor(presets: PresetService) {
    this.#presets = presets;
  }

  async getLegacyBootstrapData(): Promise<LegacyPresetBootstrapData> {
    const [
      kobold,
      novel,
      openai,
      textgenerationwebui,
      instruct,
      context,
      sysprompt,
      reasoning,
      themes,
      movingUi,
      quickReplies,
    ] = await Promise.all([
      this.#presets.list('kobold'),
      this.#presets.list('novel'),
      this.#presets.list('openai'),
      this.#presets.list('textgenerationwebui'),
      this.#presets.list('instruct'),
      this.#presets.list('context'),
      this.#presets.list('sysprompt'),
      this.#presets.list('reasoning'),
      this.#presets.list('theme'),
      this.#presets.list('moving-ui'),
      this.#presets.list('quick-reply'),
    ]);

    return {
      koboldai_settings: stringifyRecords(kobold),
      koboldai_setting_names: names(kobold),
      novelai_settings: stringifyRecords(novel),
      novelai_setting_names: names(novel),
      openai_settings: stringifyRecords(openai),
      openai_setting_names: names(openai),
      textgenerationwebui_presets: stringifyRecords(textgenerationwebui),
      textgenerationwebui_preset_names: names(textgenerationwebui),
      instruct: values(instruct),
      context: values(context),
      sysprompt: values(sysprompt),
      reasoning: values(reasoning),
      themes: values(themes),
      movingUIPresets: values(movingUi),
      quickReplyPresets: values(quickReplies),
    };
  }
}

function names(records: PresetRecord<PresetDocument>[]): string[] {
  return records.map((record) => record.name);
}

function values(records: PresetRecord<PresetDocument>[]): PresetDocument[] {
  return records.map((record) => cloneJson(record.value));
}

function stringifyRecords(records: PresetRecord<PresetDocument>[]): string[] {
  return records.map((record) => JSON.stringify(record.value));
}
