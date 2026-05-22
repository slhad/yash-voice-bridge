import { displayPath, loadOrInitAppConfig, resolveModelsDirFromConfig } from "./appConfig";

async function main(): Promise<void> {
  const config = await loadOrInitAppConfig();

  console.log(`Config file: ${displayPath(config.configFilePath)}`);
  console.log(`Config dir:  ${displayPath(config.configDir)}`);
  console.log(`Models dir:  ${displayPath(resolveModelsDirFromConfig(config))}`);
  console.log("");
  console.log(JSON.stringify(config.values, null, 2));
}

await main();
