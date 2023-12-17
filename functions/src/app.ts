import { ConfigChecker } from '@google-automations/bot-config-utils';
import { getConfig, InvalidConfigurationFormat  } from '@google-automations/bot-config-utils';

import { addOrUpdateIssue } from './issue-utils';
import { Octokit } from '@octokit/rest';
import { Probot, Context } from 'probot';
import schema from './schema.json';
import { getAuthenticatedOctokit } from './utils'
import { RepoConfig } from './types';
import { SyncRepoSettings } from './sync-repo-settings';
import { Logger, defaultLogger as logger }  from './logger';
import { YAMLException } from 'js-yaml';

export const CONFIG_FILE_NAME = 'sync-repo-settings.yaml';
//import { handlePullRequestChange } from './handle-pull-request-change';

/**
module.exports = (app: Probot) => {
  app.on('pull_request.opened', handlePullRequestChange);
  app.on('pull_request.edited', handlePullRequestChange);
  app.on('pull_request.reopened', handlePullRequestChange);
  app.on('pull_request.synchronize', handlePullRequestChange);
}
 */


module.exports = (app: Probot) =>  {
  // Lint any pull requests that touch configuration
  app.on(
    ['pull_request.opened', 'pull_request.reopened', 'pull_request.synchronize'],
    async (context: Context<'pull_request'>) => {
      let octokit: Octokit;
      if (context.payload.installation?.id) {
        octokit = await getAuthenticatedOctokit(context.payload.installation.id);
      } else {
        throw new Error('Installation ID not provided in pull_request event.' + ' We cannot authenticate Octokit.');
      }
      const configChecker = new ConfigChecker<RepoConfig>(schema, CONFIG_FILE_NAME);
      const { owner, repo } = context.repo();
      await configChecker.validateConfigChanges(
        octokit,
        owner,
        repo,
        context.payload.pull_request.head.sha,
        context.payload.pull_request.number,
      );
    },
  );
  
  app.on('push', async context => {
    let octokit: Octokit;
    if (context.payload.installation?.id) {
      octokit = await getAuthenticatedOctokit(context.payload.installation.id);
    } else {
      throw new Error('Installation ID not provided in push event.' + ' We cannot authenticate Octokit.');
    }
    const branch = context.payload.ref;
    const defaultBranch = context.payload.repository.default_branch;
    logger.info(`Got push event to ${branch}`)
    if (branch !== `refs/heads/${defaultBranch}`) {
      logger.info(`skipping non-default branch: ${branch}`);
      return;
    }
    logger.info(`processing default branch ${branch}`)
    // Look at all commits, and all files changed during those commits.
    // If they contain a `sync-repo-settings.yaml`, re-sync the repo.
    function includesConfig() {
      for (const commit of context.payload.commits) {
        for (const files of [commit.added, commit.modified, commit.removed]) {
          if (files === undefined) {
            continue;
          }
          for (const file of files) {
            if (file?.includes(CONFIG_FILE_NAME)) {
              return true;
            }
          }
        }
      }
      return false;
    }
    if (!includesConfig()) {
      logger.info('skipping push that does not modify config');
      logger.debug(context.payload.commits);
      return;
    }

    logger.info("We got a modified config file")
    const { owner, repo } = context.repo();

    let config: RepoConfig | null;
    try {
      config = await getConfig<RepoConfig>(octokit, owner, repo, CONFIG_FILE_NAME, {
        fallbackToOrgConfig: false,
        schema: schema,
      });
      logger.debug(`Config file received is ${config}`)
    } catch (e) {
      return await handleConfigurationError(e as Error, octokit, owner, repo, logger);
    }

    const repoSettings = new SyncRepoSettings(octokit, logger);
    await repoSettings.syncRepoSettings({
      repo: `${owner}/${repo}`,
      config: config || undefined,
      defaultBranch,
    });
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  app.on(['schedule.repository' as any], async context => {
    let octokit: Octokit;
    if (context.payload.installation?.id) {
      octokit = await getAuthenticatedOctokit(context.payload.installation.id);
    } else {
      throw new Error(
        'Installation ID not provided in schedule.repository event.' + ' We cannot authenticate Octokit.',
      );
    }
    logger.info(`running for org ${context.payload.cron_org}`);
    const { owner, repo } = context.repo();
    if (context.payload.cron_org !== owner) {
      logger.info(`skipping run for ${context.payload.cron_org}`);
      return;
    }

    let config: RepoConfig | null;
    try {
      config = await getConfig<RepoConfig>(octokit, owner, repo, CONFIG_FILE_NAME, {
        fallbackToOrgConfig: false,
        schema: schema,
      });
    } catch (e) {
      return await handleConfigurationError(e as Error, octokit, owner, repo, logger);
    }

    const repoSettings = new SyncRepoSettings(octokit, logger);
    await repoSettings.syncRepoSettings({
      repo: `${owner}/${repo}`,
      config: config || undefined,
    });
  });

  app.on('repository.transferred', async context => {
    let octokit: Octokit;
    if (context.payload.installation?.id) {
      octokit = await getAuthenticatedOctokit(context.payload.installation.id);
    } else {
      throw new Error(
        'Installation ID not provided in repository.transferred event.' + ' We cannot authenticate Octokit.',
      );
    }
    const { owner, repo } = context.repo();
    const defaultBranch = context.payload.repository.default_branch;
    const config = await getConfig<RepoConfig>(octokit, owner, repo, CONFIG_FILE_NAME, {
      fallbackToOrgConfig: false,
      schema: schema,
    });
    const repoSettings = new SyncRepoSettings(octokit, logger);
    await repoSettings.syncRepoSettings({
      repo: `${owner}/${repo}`,
      config: config || undefined,
      defaultBranch,
    });
  });

}


async function handleConfigurationError(e: Error, octokit: Octokit, owner: string, repo: string, logger: Logger) {
  if (e instanceof InvalidConfigurationFormat) {
    // The config does not match the defined schema -- open an issue
    const issue = await addOrUpdateIssue(
      octokit,
      owner,
      repo,
      '[SyncRepoSettings bot] - Invalid config file',
      `${e.message}\n\nSchema can be found at https://github.com/googleapis/repo-automation-bots/blob/main/packages/sync-repo-settings/src/schema.json`,
      [],
      logger,
    );
    logger.warn(`${owner}/${repo} had invalid config: opened #${issue.number}`);
    return;
  } else if (e instanceof YAMLException) {
    // The config has invalid yaml -- open an issue
    const issue = await addOrUpdateIssue(
      octokit,
      owner,
      repo,
      '[SyncRepoSettings bot] - Invalid config file',
      e.message,
      [],
      logger,
    );
    logger.warn(`${owner}/${repo} had malformed config: opened #${issue.number}`);
    return;
  }
  // some other kind of error, rethrow
  throw e;
}
