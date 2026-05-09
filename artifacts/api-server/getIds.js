const axios = require('axios');

const GITHUB_TOKEN = process.env.GITHUB_TOKEN;

const query = `
  query {
    organization(login: "Zlice-Org") {
      projectV2(number: 3) {
        id
        title
        fields(first: 20) {
          nodes {
            ... on ProjectV2SingleSelectField {
              id
              name
              options {
                id
                name
              }
            }
          }
        }
      }
    }
  }
`;

async function printAllColumnIds() {
  const res = await axios.post('https://api.github.com/graphql', { query }, {
    headers: { Authorization: `Bearer ${GITHUB_TOKEN}` }
  });

  if (res.data.errors) {
    console.log("Error:", res.data.errors[0].message);
    return;
  }

  const project = res.data.data.organization.projectV2;
  console.log(`\nProject: "${project.title}"`);
  console.log(`PROJECT_ID: ${project.id}`);

  const fields = project.fields.nodes.filter(f => f.options);
  fields.forEach(field => {
    console.log(`\nField: "${field.name}"`);
    console.log(`STATUS_FIELD_ID: ${field.id}`);
    field.options.forEach(opt => {
      console.log(`  ${opt.name}  ==>  OPTION_ID: ${opt.id}`);
    });
  });

  console.log("\n");
}

printAllColumnIds().catch(e => console.log("Error:", e.message));
