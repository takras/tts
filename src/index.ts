import TTS, { OutgoingJsonObject } from '@matanlurey/tts-editor';
import * as expander from '@matanlurey/tts-expander';
import * as steam from '@matanlurey/tts-runner/steam_finder';
import { ObjectState } from '@matanlurey/tts-save-files';
import fs from 'fs-extra';
import os from 'os';
import path from 'path';
import buildDeckSchemaLua from './lib/generate-deck-schema';

// Global's XmlUI source is meant to be just these two include directives;
// everything else it renders (the welcome dialog, the floating menu) lives
// in mod/src/includes/ui/*.xml and gets spliced in at compile time.
//
// The extractor (@matanlurey/tts-expander) does not round-trip *nested* XML
// includes: Menu.xml itself includes Welcome.xml, and when splitting a save
// back apart it bakes a fully-expanded, duplicated copy of that content
// directly into this file instead of leaving the bare include markers
// alone. Left as-is, recompiling stacks multiple copies of the welcome
// dialog in-game (and makes it unclosable, since they share the same id).
// Resetting the file after every extract is the known workaround.
const CANONICAL_GLOBAL_XML =
  '<!-- #include !/ui/Menu -->\n<!-- #include !/ui/Clock -->';

/**
 * Reads a `{TTS-SAVE-FILE}.json`, and replaces the contents of a directory.
 */
export async function extractSaveFile(
  source: string,
  output: string,
): Promise<void> {
  if (!fs.pathExists(source)) {
    throw new Error(`No source file "${source}".`);
  }
  let baseName: string | undefined;
  if (!fs.pathExists(output)) {
    console.info(`Creating output directory "${output}"`);
    await fs.mkdirp(output);
  } else {
    baseName = path.basename(source).split('.')[0];
    const modOutput = path.join(output, baseName);
    console.info(`Clearing output directory "${modOutput}"`);
    await fs.remove(modOutput);
    await fs.mkdirp(modOutput);
    console.info(`Cleared "${modOutput}"`);
  }
  const splitter = new expander.SplitIO();
  const modTree = await splitter.readSaveAndSplit(source);
  await splitter.writeSplit(output, modTree);
  console.info(`Wrote "${output}"...`);

  if (baseName) {
    const globalXmlPath = path.join(output, `${baseName}.xml`);
    if (await fs.pathExists(globalXmlPath)) {
      await fs.writeFile(globalXmlPath, CANONICAL_GLOBAL_XML, 'utf8');
      console.info(
        `Reset "${globalXmlPath}" to its include-only form (works around ` +
          `a known extractor bug with nested XML includes).`,
      );
    }
  }
}

function concatAllObjectScripts(
  states: ObjectState[],
  buffer?: OutgoingJsonObject[],
): OutgoingJsonObject[] {
  const writeBuffer = buffer || [];
  states.forEach((state) => {
    const { GUID } = state;
    if (!GUID) {
      return;
    }
    writeBuffer.push({
      guid: GUID,
      script: state.LuaScript,
      ui: state.XmlUI,
    });
    if (state.ContainedObjects) {
      concatAllObjectScripts(state.ContainedObjects, writeBuffer);
    }
  });
  return writeBuffer;
}

export async function compileSaveFile(
  source: string,
  output: string,
  options?: { reload: boolean },
): Promise<void> {
  if (!fs.pathExists(source)) {
    throw new Error(`No source directory "${source}".`);
  }
  const outputDir = path.dirname(output);
  if (!fs.pathExists(outputDir)) {
    console.info(`Creating output directory "${outputDir}"`);
    await fs.mkdirp(outputDir);
  } else {
    console.info(`Clearing output directory "${outputDir}"`);
    await fs.remove(outputDir);
    await fs.mkdirp(outputDir);
  }
  await generateFiles();
  await buildDeckSchemaLua(
    path.join('contrib', 'cards', 'official.json'),
    path.join('mod', 'src', 'includes', 'generated', 'cards.ttslua'),
  );
  console.info(`Reading "${source}"...`);
  const splitter = new expander.SplitIO();
  const saveFile = await splitter.readAndCollapse(source);
  console.info(`Writing "${output}"...`);
  await fs.writeJson(output, saveFile);
  console.info(`Wrote "${output}"...`);
  if (options?.reload) {
    const api = new TTS();
    const json: OutgoingJsonObject[] = [
      {
        guid: '-1',
        script: saveFile.LuaScript,
        ui: saveFile.XmlUI,
      },
      ...concatAllObjectScripts(saveFile.ObjectStates),
    ];
    try {
      await api.saveAndPlay(json);
      console.info(`Sent reload command!`);
    } catch (e) {
      console.warn(`Could not reload. Is TTS currently running?`, e);
    }
  }
}

/**
 * Finds the Tabletop Simulator home directory (the one containing `Saves`).
 *
 * Honors `TTS_HOME` on any platform, and auto-detects a OneDrive-redirected
 * Documents folder on Windows (which `steam.homeDir.win32` does not account
 * for). Otherwise falls back to each platform's normal default location.
 */
function defaultTTSHomeDir(): string {
  if (process.env.TTS_HOME) {
    return process.env.TTS_HOME;
  }
  const platform = os.platform();
  if (platform === 'win32') {
    if (process.env.OneDrive) {
      const oneDriveHome = path.join(
        process.env.OneDrive,
        'Documents',
        'My Games',
        'Tabletop Simulator',
      );
      if (fs.existsSync(oneDriveHome)) {
        return oneDriveHome;
      }
    }
    return steam.homeDir.win32(process.env);
  }
  if (platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Tabletop Simulator');
  }
  if (platform === 'linux') {
    return path.join(os.homedir(), '.local', 'share', 'Tabletop Simulator');
  }
  throw new Error(`Unsupported platform: ${platform}`);
}

export async function destroySymlink(homeDir?: string): Promise<void> {
  if (!homeDir) {
    homeDir = defaultTTSHomeDir();
  }
  const from = path.join(homeDir, 'Saves', 'TTSDevLink');
  return fs.remove(from);
}

export async function createSymlink(homeDir?: string): Promise<string> {
  if (!homeDir) {
    homeDir = defaultTTSHomeDir();
  }
  await destroySymlink(homeDir);
  const from = path.join(homeDir, 'Saves', 'TTSDevLink');
  await fs.symlink(
    path.resolve('dist'),
    from,
    os.platform() === 'win32' ? 'junction' : 'dir',
  );
  return from;
}

export async function generateFiles(): Promise<void> {
  console.info(`Generating additional files...`);
  await buildDeckSchemaLua(
    path.join('contrib', 'cards', 'official.json'),
    path.join('mod', 'src', 'includes', 'generated', 'cards.ttslua'),
  );
}
