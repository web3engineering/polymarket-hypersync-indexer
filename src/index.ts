import { config } from './config';
import { runFillsFlow } from './flows/fills';
import { runConditionalTokensEventsFlow } from './flows/conditionalTokensEvents';
import { runConvertFlow } from './flows/convert';

async function main() {
  if (config.flow === 'fills') {
    await runFillsFlow();
    return;
  }

  if (config.flow === 'convert') {
    await runConvertFlow();
    return;
  }

  await runConditionalTokensEventsFlow();
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
