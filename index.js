const { WebClient, retryPolicies, ErrorCode } = require('@slack/web-api');
const R = require('ramda');
const dayjs = require('dayjs');
const relativeTime = require('dayjs/plugin/relativeTime');
const slackifyMarkdown = require('slackify-markdown');

dayjs.extend(relativeTime);

class ServerlessPluginNotification {
    constructor(serverless, options) {
        this.pluginName = 'Slack notification plugin';
        this.serverless = serverless;
        this.options = options;
        this.service = this.serverless.service;
        this.startedAt = null;
        this.deploymentStartMessage = null;
        this.finishedAt = null;
        this.stage = this.options.stage || this.provider.stage;
        this.config = {
            enabled: {
                [this.stage]: true,
            },
        };
        this.awsDeploymentInfo = null;

        this.hooks = {
            // service configuration is final
            'after:package:setupProviderConfiguration': this.initializePlugin.bind(this),

            // before service deployment
            'before:deploy:deploy': this.beforeDeploy.bind(this),

            // after service deployment
            'after:deploy:deploy': this.afterDeploy.bind(this),
        };
    }

    initializePlugin() {
        this.config = R.mergeDeepRight(
            this.config,
            R.propOr({}, 'slackDeployNotification', this.serverless.service.custom)
        );

        if (!this.isConfigValid()) {
            this.serverless.cli.log('Required params missing (token, channel)', this.pluginName, { color: 'red' });
        }

        if (this.config.enabled[this.stage] === false) {
            return;
        }

        this.slack = new WebClient(this.config.token, {
            retryConfig: retryPolicies.fiveRetriesInFiveMinutes,
        });
    }

    displayServiceInfo() {
        const info = this.awsDeploymentInfo.info;

        let message = '';
        message += '*Service Information*\n';
        message += `*service:* ${info.service}\n`;
        message += `*stage:* ${info.stage}\n`;
        message += `*region:* ${info.region}\n`;
        message += `*stack:* ${info.stack}\n`;
        message += `*resources:* ${info.resourceCount}`;

        if (info.resourceCount >= 450) {
            message += '\n*WARNING\n';
            message += `  You have ${info.resourceCount} resources in your service.\n`;
            message += '  CloudFormation has a hard limit of 500 resources in a service.\n';
            message += '  For advice on avoiding this limit, check out this link: http://bit.ly/2IiYB38.';
        }

        return message;
    }

    displayApiKeys() {
        const conceal = this.options.conceal;
        const info = this.awsDeploymentInfo.info;
        let apiKeysMessage = '*API keys*';

        if (info.apiKeys && info.apiKeys.length > 0) {
            info.apiKeys.forEach((apiKeyInfo) => {
                const description = apiKeyInfo.description ? ` - ${apiKeyInfo.description}` : '';
                if (conceal) {
                    apiKeysMessage += `\n  ${apiKeyInfo.name}${description}`;
                } else {
                    apiKeysMessage += `\n  ${apiKeyInfo.name}: ${apiKeyInfo.value}${description}`;
                }
            });
        } else {
            apiKeysMessage += '\n  None';
        }

        return apiKeysMessage;
    }

    displayEndpoints() {
        const info = this.awsDeploymentInfo.info;
        let endpointsMessage = '*Endpoints*';

        if (info.endpoints && info.endpoints.length) {
            info.endpoints.forEach((endpoint) => {
                // if the endpoint is of type http(s)
                if (endpoint.startsWith('https://')) {
                    Object.values(this.serverless.service.functions).forEach((functionObject) => {
                        functionObject.events.forEach((event) => {
                            if (event.http) {
                                let method;
                                let path;

                                if (typeof event.http === 'object') {
                                    method = event.http.method.toUpperCase();
                                    path = event.http.path;
                                } else {
                                    method = event.http.split(' ')[0].toUpperCase();
                                    path = event.http.split(' ')[1];
                                }
                                path =
                                    path !== '/'
                                        ? `/${path
                                              .split('/')
                                              .filter((p) => p !== '')
                                              .join('/')}`
                                        : '';
                                endpointsMessage += `\n  ${method} - ${endpoint}${path}`;
                            }
                        });
                    });
                } else if (endpoint.startsWith('httpApi: ')) {
                    // eslint-disable-next-line no-param-reassign
                    endpoint = endpoint.slice('httpApi: '.length);
                    const { httpApiEventsPlugin } = this.serverless;
                    httpApiEventsPlugin.resolveConfiguration();

                    // eslint-disable-next-line no-restricted-syntax
                    for (const functionData of Object.values(this.serverless.service.functions)) {
                        // eslint-disable-next-line no-restricted-syntax
                        for (const event of functionData.events) {
                            if (!event.httpApi) {
                                // eslint-disable-next-line no-continue
                                continue;
                            }
                            endpointsMessage += `\n  ${event.resolvedMethod} - ${endpoint}${event.resolvedPath || ''}`;
                        }
                    }
                } else {
                    // if the endpoint is not of type http(s) (e.g. wss) we just display
                    endpointsMessage += `\n  ${endpoint}`;
                }
            });
        }

        if (info.cloudFront) {
            endpointsMessage += `\n  CloudFront - ${info.cloudFront}`;
        }

        if (!info.endpoints.length && !info.cloudFront) {
            endpointsMessage += '\n  None';
        }

        return endpointsMessage;
    }

    displayFunctions() {
        const info = this.awsDeploymentInfo.info;
        let functionsMessage = '*Functions:';

        if (info.functions && info.functions.length > 0) {
            info.functions.forEach((f) => {
                functionsMessage += `\n  ${f.name}: ${f.deployedName}`;
            });
        } else {
            functionsMessage += '\n  None';
        }

        return functionsMessage;
    }

    displayLayers() {
        const info = this.awsDeploymentInfo.info;
        let layersMessage = '*Layers*';

        if (info.layers && info.layers.length > 0) {
            info.layers.forEach((l) => {
                layersMessage += `\n  ${l.name}: ${l.arn}`;
            });
        } else {
            layersMessage += '\n  None';
        }

        return layersMessage;
    }

    generateMessage() {
        const deployer =
            process.env.USER ||
            process.env.LOGNAME ||
            process.env.USERNAME ||
            process.env.SUDO_USER ||
            process.env.LNAME ||
            this.custom().deployer ||
            'Unnamed deployer';
        const currentRevision = require('child_process').execSync('git rev-parse HEAD').toString().trim().slice(0, 7);
        const currentCommitMessage = require('child_process')
            .execSync('git show -s --format=%B HEAD')
            .toString()
            .trim();

        return {
            text: !this.finishedAt
                ? `*${this.service.service}* ${deployer} triggered *${this.stage}* deployment :siren:`
                : `*${this.service.service}* *${this.stage}* deployment successful :fuckyeah:`,
            blocks: [
                {
                    type: 'header',
                    text: {
                        type: 'plain_text',
                        text: !this.finishedAt
                            ? `${this.service.service} ${this.stage} deployment in progress :siren:`
                            : `${this.service.service} ${this.stage} deployment successful :fuckyeah:`,
                        emoji: true,
                    },
                },
                {
                    type: 'divider',
                },
                {
                    type: 'section',
                    text: {
                        type: 'mrkdwn',
                        text: slackifyMarkdown(currentCommitMessage),
                    },
                },
                {
                    type: 'section',
                    accessory: this.config.logo && {
                        type: 'image',
                        image_url: this.config.logo,
                        alt_text: this.service.service,
                    },
                    fields: [
                        {
                            type: 'mrkdwn',
                            text: '*Stage*',
                        },
                        {
                            type: 'mrkdwn',
                            text: '*Deployer*',
                        },
                        {
                            type: 'plain_text',
                            text: this.stage,
                        },
                        {
                            type: 'plain_text',
                            text: deployer,
                        },
                        {
                            type: 'mrkdwn',
                            text: '*Started at*',
                        },
                        {
                            type: 'mrkdwn',
                            text: '*Finished at*',
                        },
                        {
                            type: 'plain_text',
                            text: this.startedAt ? this.startedAt.format('YYYY-MM-DD HH:mm:ss') : '-',
                        },
                        {
                            type: 'plain_text',
                            text: this.finishedAt
                                ? `${this.finishedAt.format('YYYY-MM-DD HH:mm:ss')}\n (took ${this.finishedAt.from(
                                      this.startedAt,
                                      true
                                  )})`
                                : '-',
                        },
                    ],
                },
                ((this.finishedAt && this.config.appUrl) || process.env.TRAVIS_BUILD_ID) && {
                    type: 'actions',
                    elements: [
                        this.finishedAt &&
                            this.config.appUrl && {
                                type: 'button',
                                text: {
                                    type: 'plain_text',
                                    text: ':aws-logo: deployed app',
                                    emoji: true,
                                },
                                url: this.config.appUrl,
                            },
                        process.env.TRAVIS_BUILD_ID &&
                            this.config.travisUrl && {
                                type: 'button',
                                text: {
                                    type: 'plain_text',
                                    text: `:travis: #${process.env.TRAVIS_BUILD_NUMBER}`,
                                    emoji: true,
                                },
                                url: `${this.config.travisUrl}/builds/${process.env.TRAVIS_BUILD_ID}`,
                            },
                        this.config.githubUrl &&
                            currentRevision && {
                                type: 'button',
                                text: {
                                    type: 'plain_text',
                                    text: `:github: ${currentRevision}`,
                                    emoji: true,
                                },
                                url: `${this.config.githubUrl}/commit/${currentRevision}`,
                            },
                    ].filter(Boolean),
                },
            ].filter(Boolean),
        };
    }

    generateAppDetailsMessage() {
        const awsInfo = this.serverless.pluginManager
            .getPlugins()
            .find((plugin) => plugin.constructor.name === 'AwsInfo');

        this.awsDeploymentInfo = awsInfo.gatheredData;

        return {
            text: 'Application details',
            blocks: [
                {
                    type: 'header',
                    text: {
                        type: 'plain_text',
                        text: 'Application details :mag:',
                        emoji: true,
                    },
                },
                {
                    type: 'section',
                    text: {
                        type: 'mrkdwn',
                        text: this.displayServiceInfo(),
                    },
                },
                {
                    type: 'section',
                    text: {
                        type: 'mrkdwn',
                        text: this.displayApiKeys(),
                    },
                },
                {
                    type: 'section',
                    text: {
                        type: 'mrkdwn',
                        text: this.displayEndpoints(),
                    },
                },
                {
                    type: 'section',
                    text: {
                        type: 'mrkdwn',
                        text: this.displayFunctions(),
                    },
                },
                {
                    type: 'section',
                    text: {
                        type: 'mrkdwn',
                        text: this.displayLayers(),
                    },
                },
            ],
        };
    }

    isConfigValid() {
        return R.allPass([R.has('channel'), R.has('token')])(this.config);
    }

    async beforeDeploy() {
        if (this.config.enabled[this.stage] === false) {
            return;
        }

        this.serverless.cli.log("Sending a 'deployment started' notification", this.pluginName);

        this.startedAt = dayjs();
        try {
            this.deploymentStartMessage = await this.slack.chat.postMessage({
                ...this.generateMessage(),
                channel: this.config.channel,
            });
        } catch (error) {
            // Check the code property, and when its a PlatformError, log the whole response.
            if (error.code === ErrorCode.PlatformError) {
                this.serverless.cli.log(`Slack API error: ${JSON.stringify(error.data)}`, this.pluginName, {
                    color: 'red',
                });
            } else {
                // Some other error, oh no!
                this.serverless.cli.log(`Slack API error: ${error.message}`, this.pluginName, { color: 'red' });
            }
        }
    }

    async afterDeploy() {
        if (this.config.enabled[this.stage] === false || !this.deploymentStartMessage) {
            return;
        }

        this.serverless.cli.log("Sending a 'deployment finished' notification", this.pluginName, { color: 'green' });

        this.finishedAt = dayjs();
        try {
            await Promise.all([
                await this.slack.chat.update({
                    ...this.generateMessage(),
                    ts: this.deploymentStartMessage.ts,
                    channel: this.config.channel,
                }),

                this.slack.chat.postMessage({
                    ...this.generateAppDetailsMessage(),
                    thread_ts: this.deploymentStartMessage.ts,
                    channel: this.config.channel,
                }),
            ]);
        } catch (error) {
            // Check the code property, and when its a PlatformError, log the whole response.
            if (error.code === ErrorCode.PlatformError) {
                this.serverless.cli.log(`Slack API error: ${JSON.stringify(error.data)}`, this.pluginName, {
                    color: 'red',
                });
            } else {
                // Some other error, oh no!
                this.serverless.cli.log(`Slack API error: ${error.message}`, this.pluginName, { color: 'red' });
            }
        }
    }
}

module.exports = ServerlessPluginNotification;
