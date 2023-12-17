import fs from 'fs';

import { Octokit } from '@octokit/rest';
import { createAppAuth } from '@octokit/auth-app';

export interface BotSecrets {
  privateKey: string;
  appId: string;
  webhookSecret: string;
}


export async function getAuthenticatedOctokit(installationId: number | undefined): Promise<Octokit> {
  const botSecrets = await getBotSecrets();
  if (installationId === undefined || installationId === null) {
    // Authenticate as a bot.
    return new Octokit({
      authStrategy: createAppAuth,
      auth: {
        appId: botSecrets.appId,
        privateKey: botSecrets.privateKey,
      },
    });
  }
  // Authenticate as an installation.
  return new Octokit({
    authStrategy: createAppAuth,
    auth: {
      appId: botSecrets.appId,
      privateKey: botSecrets.privateKey,
      installationId: installationId,
    },
  });
}

export async function getBotSecrets(): Promise<BotSecrets> {
  const privateKeyPath = process.env.PRIVATE_KEY_PATH as string;
  const privateKey = fs.readFileSync(privateKeyPath, 'utf8');
  const appId = process.env.APP_ID as string;
  const webhookSecret = process.env.WEBHOOK_SECRET as string;
  return {
    privateKey: privateKey,
    appId: appId,
    webhookSecret: webhookSecret,
  };
}