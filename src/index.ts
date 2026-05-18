import { config } from './config';
import { runFillsFlow } from './flows/fills';
import { runConditionalTokensEventsFlow } from './flows/conditionalTokensEvents';

async function main() {
  if (config.flow === 'fills') {
    await runFillsFlow();
    return;
  }

  await runConditionalTokensEventsFlow();
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
