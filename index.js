const { Client, GatewayIntentBits, ChannelType } = require('discord.js');
const axios = require('axios');
const express = require('express');
const bodyParser = require('body-parser');

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
});

const app = express();
app.use(bodyParser.json());

// --- HELPER: GITHUB GRAPHQL ---
async function queryGitHub(query, variables) {
  const response = await axios.post('https://api.github.com/graphql', { query, variables }, {
    headers: { Authorization: `Bearer ${process.env.GITHUB_TOKEN}` }
  });
  if (response.data.errors) {
    console.error("🚨 GRAPHQL ERROR:", JSON.stringify(response.data.errors, null, 2));
    throw new Error("GitHub rejected the GraphQL request.");
  }
  return response;
}

// --- FEATURE 1: AUTOMATED CHANNEL CREATION (DYNAMIC REPO) ---
app.post('/webhook', async (req, res) => {
  const event = req.headers['x-github-event'];
  const action = req.body.action;

  if (event === 'pull_request' && action === 'opened') {
    const pr = req.body.pull_request;
    const repoName = req.body.repository.name; // Dynamically pulls from any of the 10 repos
    const prNumber = pr.number;
    
    // Discord channel format: #repo-name-prnumber (e.g., #zlice-kitchen-15)
    const channelName = `${repoName}-${prNumber}`.toLowerCase(); 

    try {
      const guild = client.guilds.cache.first(); 
      if (!guild) return console.log("❌ Discord Guild not found");

      const newChannel = await guild.channels.create({
        name: channelName,
        type: ChannelType.GuildText,
        topic: `Discussion for PR #${prNumber} in ${repoName}: ${pr.html_url}`,
      });

      console.log(`🚀 Automated Channel Created: #${channelName}`);
      newChannel.send(`🚀 **New PR Raised in \`${repoName}\`:** #${prNumber}\n**Title:** ${pr.title}\n**Link:** ${pr.html_url}\n\nUse \`Description -> ...\` and \`Label -> ...\` here to sync with the board.`);
    } catch (err) {
      console.error("❌ Failed to create channel:", err);
    }
  }
  res.status(200).send('OK');
});

// --- FEATURE 2: BOARD SYNC LOGIC (DYNAMIC REPO ROUTING) ---
client.on('messageCreate', async (message) => {
  // Trigger if the message contains "Label ->" or "Labels ->" (case insensitive)
  if (message.author.bot || !/Labels?\s*->/i.test(message.content)) return;

  try {
    console.log("\n🚀 --- NEW ENGINE SYNC STARTED --- 🚀");

    let description = "";
    let labelInput = "";

    // 1. Extract the Label
    const labelMatch = message.content.match(/Labels?\s*->\s*(.+)/i);
    if (labelMatch) labelInput = labelMatch[1].trim().toLowerCase();

    // 2. Extract the Description
    const descMatch = message.content.match(/Description\s*->\s*([\s\S]*?)(?=Labels?\s*->)/i);
    if (descMatch) {
      description = descMatch[1].trim();
    } else {
      const parts = message.content.split(/Labels?\s*->/i);
      description = parts[0].trim();
    }

    // Extract dynamic Repo Name and PR Number from the channel name
    const channelParts = message.channel.name.split('-');
    const prNumber = parseInt(channelParts.pop()); 
    const repoName = channelParts.join('-'); 

    if (!prNumber || !repoName) return message.reply("❌ Cannot identify PR number or Repo from channel name.");

    console.log(`📌 Target Repo: ${repoName} | PR: ${prNumber} | Label: "${labelInput}"`);

    // 3. REST API: Dynamic Repo Target
    const restBase = `https://api.github.com/repos/${process.env.GITHUB_OWNER}/${repoName}/issues/${prNumber}`;
    const restHeaders = { headers: { Authorization: `token ${process.env.GITHUB_TOKEN}` } };
    await axios.post(`${restBase}/comments`, { body: `**Zlice Engine Update:**\n\n${description}` }, restHeaders);
    await axios.post(`${restBase}/labels`, { labels: [labelInput] }, restHeaders);

    // 4. GraphQL API: Dynamic Repo Target
    const findItemQuery = `
      query($owner: String!, $repo: String!, $pr: Int!) {
        repository(owner: $owner, name: $repo) {
          pullRequest(number: $pr) {
            projectItems(first: 5) {
              nodes { id project { id title } }
            }
            closingIssuesReferences(first: 5) {
              nodes {
                projectItems(first: 5) {
                  nodes { id project { id title } }
                }
              }
            }
          }
        }
      }`;

    const itemData = await queryGitHub(findItemQuery, { owner: process.env.GITHUB_OWNER, repo: repoName, pr: prNumber });
    const prData = itemData.data.data.repository.pullRequest;

    let projectItem = null;

    if (prData.projectItems.nodes && prData.projectItems.nodes.length > 0) {
      projectItem = prData.projectItems.nodes[0];
      console.log(`🎯 Found PR directly on Board: "${projectItem.project.title}"`);
    } 
    else if (prData.closingIssuesReferences.nodes && prData.closingIssuesReferences.nodes.length > 0) {
      for (const issue of prData.closingIssuesReferences.nodes) {
        if (issue.projectItems.nodes && issue.projectItems.nodes.length > 0) {
          projectItem = issue.projectItems.nodes[0];
          console.log(`🎯 Found linked Issue on Board: "${projectItem.project.title}"`);
          break;
        }
      }
    }

    if (projectItem) {
      let targetOptionId = "";

      // Maps Discord labels to GitHub Project column IDs
      if (labelInput.includes("done review (weekday)")) targetOptionId = process.env.OPTION_ID_REVIEW_FOUNDER;
      else if (labelInput.includes("bug")) targetOptionId = process.env.OPTION_ID_TODO;
      else if (labelInput.includes("weekday")) targetOptionId = process.env.OPTION_ID_REVIEW;
      else if (labelInput.includes("weekend")) targetOptionId = process.env.OPTION_ID_DONE;

      if (targetOptionId) {
        const moveMutation = `
          mutation($projectId: ID!, $itemId: ID!, $fieldId: ID!, $optionId: String!) {
            updateProjectV2ItemFieldValue(input: {
              projectId: $projectId,
              itemId: $itemId,
              fieldId: $fieldId,
              value: { singleSelectOptionId: $optionId }
            }) { projectV2Item { id } }
          }`;

        const result = await queryGitHub(moveMutation, {
          projectId: projectItem.project.id,
          itemId: projectItem.id,
          fieldId: process.env.STATUS_FIELD_ID,
          optionId: targetOptionId
        });
        console.log("✅ GitHub Mutation Response:", JSON.stringify(result.data.data, null, 2));
      }
    } else {
      console.log("❌ Could not find this PR (or its linked Issue) attached to any Project Board!");
    }

    message.reply(`✅ **Engine Sync Complete**\n- Comment added\n- Label **${labelInput}** applied\n- Board card moved.`);
    console.log("🏁 --- SYNC FINISHED ---\n");

  } catch (error) {
    console.error("🔥 CRITICAL ERROR:", error.message);
    message.reply("❌ Sync failed. Check Replit logs.");
  }
});

client.login(process.env.DISCORD_BOT_TOKEN);

// Server ping response
app.get(['/', '/api'], (req, res) => {
  res.send('Zlice Engine & Webhook Listener Online');
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`Listening for Webhooks on Port ${PORT}...`));
