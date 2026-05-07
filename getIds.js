const axios = require('axios');

const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const REPO_OWNER = process.env.GITHUB_OWNER;
const REPO_NAME = process.env.GITHUB_REPO;

async function graphql(query, variables) {
  const res = await axios.post('https://api.github.com/graphql', { query, variables }, {
    headers: { Authorization: `Bearer ${GITHUB_TOKEN}` }
  });
  if (res.data.errors) throw new Error(res.data.errors[0].message);
  return res.data.data;
}

async function printAllColumnIds() {
  const data = await graphql(`
    query($owner: String!, $repo: String!) {
      repository(owner: $owner, name: $repo) {
        projectsV2(first: 10) {
          nodes {
            id
            title
            fields(first: 20) {
              nodes {
                ... on ProjectV2SingleSelectField {
                  id
                  name
                  options { id name }
                }
              }
            }
          }
        }
      }
    }
  `, { owner: REPO_OWNER, repo: REPO_NAME });

  const projects = data.repository.projectsV2.nodes;
  if (!projects.length) {
    console.log("No projects found for this repo.");
    return;
  }

  projects.forEach(project => {
    console.log(`\nProject: "${project.title}"  (ID: ${project.id})`);
    const fields = project.fields.nodes.filter(f => f.options);
    if (!fields.length) {
      console.log("  No single-select fields found.");
      return;
    }
    fields.forEach(field => {
      console.log(`\n  Field: "${field.name}"  (STATUS_FIELD_ID: ${field.id})`);
      field.options.forEach(opt => {
        console.log(`    Column: "${opt.name}"  ==>  ID: ${opt.id}`);
      });
    });
  });

  console.log("\n");
}

printAllColumnIds().catch(e => console.log("Error:", e.message));
