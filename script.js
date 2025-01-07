/* globals bootstrap */
import sqlite3InitModule from "https://esm.sh/@sqlite.org/sqlite-wasm@3.46.1-build3";
import { render, html } from "https://cdn.jsdelivr.net/npm/lit-html@3/+esm";
import { unsafeHTML } from "https://cdn.jsdelivr.net/npm/lit-html@3/directives/unsafe-html.js";
import { dsvFormat, autoType } from "https://cdn.jsdelivr.net/npm/d3-dsv@3/+esm";
import { Marked } from "https://cdn.jsdelivr.net/npm/marked@13/+esm";
import { markedHighlight } from "https://cdn.jsdelivr.net/npm/marked-highlight@2/+esm";
import hljs from "https://cdn.jsdelivr.net/npm/highlight.js@11/+esm";
// 'Chart' is globally available from the <script> tag in index.html

//--------------------------------------------------------------------
// 1. Initialize SQLite
const defaultDB = "@";
const sqlite3 = await sqlite3InitModule({ printErr: console.error });

//--------------------------------------------------------------------
// 2. Grab DOM elements
const $demos = document.querySelector("#demos");
const $upload = document.getElementById("upload");
const $tablesContainer = document.getElementById("tables-container");
const $sql = document.getElementById("sql");
const $toast = document.getElementById("toast");
const $result = document.getElementById("result");
const $chartCode = document.getElementById("chart-code");
const $categoryFilterContainer = document.getElementById("category-filter-container");
const $categoryFilter = document.getElementById("category-filter");
const toast = new bootstrap.Toast($toast);
const loading = html`<div class="spinner-border" role="status"><span class="visually-hidden">Loading...</span></div>`;

let latestQueryResult = [];
let latestChart;
let showTop10 = false; // Global flag for Top 10 toggle

//--------------------------------------------------------------------
// 3. Markdown + syntax highlighting
const marked = new Marked(
  markedHighlight({
    langPrefix: "hljs language-",
    highlight(code, lang) {
      const language = hljs.getLanguage(lang) ? lang : "plaintext";
      return hljs.highlight(code, { language }).value;
    },
  })
);

marked.use({
  renderer: {
    table(header, body) {
      return `<table class="table table-sm">${header}${body}</table>`;
    },
  },
});

//--------------------------------------------------------------------
// 4. Retrieve LLM token
let token;
try {
  token = (await fetch("https://llmfoundry.straive.com/token", { credentials: "include" }).then((r) => r.json())).token;
} catch {
  token = null;
}

// Conditionally render upload input or sign-in link
render(
  token
    ? html`
        <div class="mb-3">
          <label for="file" class="form-label">Upload CSV (.csv) or SQLite DB (.sqlite3, .db)</label>
          <input
            class="form-control"
            type="file"
            id="file"
            name="file"
            accept=".csv,.sqlite3,.db,.sqlite,.s3db,.sl3"
            multiple
          />
        </div>
      `
    : html`<a class="btn btn-primary" href="https://llmfoundry.straive.com/">Sign in to upload files</a>`,
  $upload
);

//--------------------------------------------------------------------
// 5. Load & render demos from config.json
fetch("config.json")
  .then((r) => r.json())
  .then(({ demos }) => {
    $demos.innerHTML = "";
    render(
      demos.map(
        ({ title, body, file, context, questions }) =>
          html`
            <div class="col py-3">
              <a
                class="demo card h-100 text-decoration-none"
                href="${file}"
                data-questions=${JSON.stringify(questions ?? [])}
                data-context=${JSON.stringify(context ?? "")}
              >
                <div class="card-body">
                  <h5 class="card-title">${title}</h5>
                  <p class="card-text">${body}</p>
                </div>
              </a>
            </div>
          `
      ),
      $demos
    );
  });

$demos.addEventListener("click", async (e) => {
  const $demo = e.target.closest(".demo");
  if ($demo) {
    e.preventDefault();
    const file = $demo.getAttribute("href");
    render(html`<div class="text-center my-3">${loading}</div>`, $tablesContainer);
    await DB.upload(new File([await fetch(file).then((r) => r.blob())], file.split("/").pop()));
    const questions = JSON.parse($demo.dataset.questions);
    if (questions.length) {
      DB.questionInfo.schema = JSON.stringify(DB.schema());
      DB.questionInfo.questions = questions;
    }
    DB.context = JSON.parse($demo.dataset.context);
    drawTables();
    loadCategories(); // Load categories after demo upload
    // Show the category filter if categories exist
    if (document.querySelectorAll(".category-checkbox").length > 0) { // More than "All Categories"
      $categoryFilterContainer.style.display = "block";
    } else {
      $categoryFilterContainer.style.display = "none";
    }
  }
});

//--------------------------------------------------------------------
// 6. Our in-memory DB instance
const db = new sqlite3.oo1.DB(defaultDB, "c");

const DB = {
  schema: function () {
    const tables = [];
    db.exec("SELECT name, sql FROM sqlite_master WHERE type='table'", { rowMode: "object" }).forEach((table) => {
      table.columns = db.exec(`PRAGMA table_info(${table.name})`, { rowMode: "object" });
      tables.push(table);
    });
    return tables;
  },

  questionInfo: {},
  questions: async function () {
    if (DB.questionInfo.schema !== JSON.stringify(DB.schema())) {
      const response = await llm({
        system: "Suggest 5 diverse, useful questions that a user can answer from this dataset using SQLite",
        user: DB.schema()
          .map(({ sql }) => sql)
          .join("\n\n"),
        schema: {
          type: "object",
          properties: {
            questions: {
              type: "array",
              items: { type: "string" },
              additionalProperties: false,
            },
          },
          required: ["questions"],
          additionalProperties: false,
        },
      });
      if (response.error) DB.questionInfo.error = response.error;
      else DB.questionInfo.questions = response.questions;
      DB.questionInfo.schema = JSON.stringify(DB.schema());
    }
    return DB.questionInfo;
  },

  upload: async function (file) {
    if (file.name.match(/\.(sqlite3|sqlite|db|s3db|sl3)$/i)) await DB.uploadSQLite(file);
    else if (file.name.match(/\.csv$/i)) await DB.uploadDSV(file, ",");
    else if (file.name.match(/\.tsv$/i)) await DB.uploadDSV(file, "\t");
    else notify("danger", "Unknown file type", `Unknown file type: ${file.name}`);
  },

  uploadSQLite: async function (file) {
    const fileReader = new FileReader();
    await new Promise((resolve) => {
      fileReader.onload = async (e) => {
        await sqlite3.capi.sqlite3_js_posix_create_file(file.name, e.target.result);
        const uploadDB = new sqlite3.oo1.DB(file.name, "r");
        const tables = uploadDB.exec("SELECT name, sql FROM sqlite_master WHERE type='table'", { rowMode: "object" });
        for (const { name, sql } of tables) {
          db.exec(`DROP TABLE IF EXISTS "${name}"`);
          db.exec(sql);
          const data = uploadDB.exec(`SELECT * FROM "${name}"`, { rowMode: "object" });
          if (data.length > 0) {
            const columns = Object.keys(data[0]);
            const insertSQL = `INSERT INTO "${name}" (${columns.map((c) => `"${c}"`).join(", ")}) VALUES (${columns
              .map(() => "?")
              .join(", ")})`;
            const stmt = db.prepare(insertSQL);
            db.exec("BEGIN TRANSACTION");
            for (const row of data) {
              stmt.bind(columns.map((c) => row[c])).stepReset();
            }
            db.exec("COMMIT");
            stmt.finalize();
          }
        }
        uploadDB.close();
        resolve();
      };
      fileReader.readAsArrayBuffer(file);
    });
    notify("success", "Imported", `Imported SQLite DB: ${file.name}`);
  },

  uploadDSV: async function (file, separator) {
    const fileReader = new FileReader();
    const result = await new Promise((resolve) => {
      fileReader.onload = (e) => {
        const rows = dsvFormat(separator).parse(e.target.result, autoType);
        resolve(rows);
      };
      fileReader.readAsText(file);
    });
    const tableName = file.name.slice(0, -4).replace(/[^a-zA-Z0-9_]/g, "_");
    await DB.insertRows(tableName, result);
  },

  insertRows: async function (tableName, result) {
    if (!result.length) {
      notify("warning", "No data", `File has no rows: ${tableName}`);
      return;
    }
    const cols = Object.keys(result[0]);
    const typeMap = Object.fromEntries(
      cols.map((col) => {
        const sampleValue = result[0][col];
        let sqlType = "TEXT";
        if (typeof sampleValue === "number") sqlType = Number.isInteger(sampleValue) ? "INTEGER" : "REAL";
        else if (typeof sampleValue === "boolean") sqlType = "INTEGER";
        else if (sampleValue instanceof Date) sqlType = "TEXT";
        return [col, sqlType];
      })
    );
    const createTableSQL = `CREATE TABLE IF NOT EXISTS ${tableName} (${cols.map((col) => `[${col}] ${typeMap[col]}`).join(", ")})`;
    db.exec(createTableSQL);

    const insertSQL = `INSERT INTO ${tableName} (${cols.map((col) => `[${col}]`).join(", ")}) VALUES (${cols
      .map(() => "?")
      .join(", ")})`;
    const stmt = db.prepare(insertSQL);
    db.exec("BEGIN TRANSACTION");
    for (const row of result) {
      stmt
        .bind(
          cols.map((col) => {
            const value = row[col];
            return value instanceof Date ? value.toISOString() : value;
          })
        )
        .stepReset();
    }
    db.exec("COMMIT");
    stmt.finalize();
    notify("success", "Imported", `Imported table: ${tableName}`);
  },
};

// Listen for file uploads
$upload.addEventListener("change", async (e) => {
  const files = Array.from(e.target.files);
  await Promise.all(files.map((file) => DB.upload(file)));
  drawTables();
  loadCategories(); // Load categories after upload
  // Show the category filter if categories exist
  if (document.querySelectorAll(".category-checkbox").length > 0) { // More than "All Categories"
    $categoryFilterContainer.style.display = "block";
  } else {
    $categoryFilterContainer.style.display = "none";
  }
});

//--------------------------------------------------------------------
// 7. Render DB tables & question form
async function drawTables() {
  const schema = DB.schema();

  const tables = html`
    <div class="accordion narrative mx-auto" id="table-accordion" style="--bs-accordion-btn-padding-y: 0.5rem">
      ${schema.map(
        ({ name, sql, columns }) => html`
          <div class="accordion-item">
            <h2 class="accordion-header">
              <button
                class="accordion-button collapsed"
                type="button"
                data-bs-toggle="collapse"
                data-bs-target="#collapse-${name}"
                aria-expanded="false"
                aria-controls="collapse-${name}"
              >
                ${name}
              </button>
            </h2>
            <div
              id="collapse-${name}"
              class="accordion-collapse collapse"
              data-bs-parent="#table-accordion"
            >
              <div class="accordion-body">
                <pre style="white-space: pre-wrap">${sql}</pre>
                <table class="table table-striped table-sm">
                  <thead>
                    <tr>
                      <th>Column Name</th>
                      <th>Type</th>
                      <th>Not Null</th>
                      <th>Default Value</th>
                      <th>Primary Key</th>
                    </tr>
                  </thead>
                  <tbody>
                    ${columns.map(
                      (column) => html`
                        <tr>
                          <td>${column.name}</td>
                          <td>${column.type}</td>
                          <td>${column.notnull ? "Yes" : "No"}</td>
                          <td>${column.dflt_value ?? "NULL"}</td>
                          <td>${column.pk ? "Yes" : "No"}</td>
                        </tr>
                      `
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        `
      )}
    </div>
  `;

  // Query Form
  const queryForm = () => html`
    <form class="mt-4 narrative mx-auto">
      <div class="mb-3">
        <label for="context" class="form-label fw-bold">Provide context about your dataset:</label>
        <textarea class="form-control" name="context" id="context" rows="3">${DB.context || ""}</textarea>
      </div>
      <div class="mb-3">
        <label for="query" class="form-label fw-bold">Ask a question about your data:</label>
        <textarea class="form-control" name="query" id="query" rows="3"></textarea>
      </div>
      <div class="d-flex align-items-center gap-2">
        <button type="submit" class="btn btn-primary">Submit</button>
        <!-- The D3 lineage button -->
        <button id="lineage-d3-button" type="button" class="btn btn-secondary">
          <i class="bi bi-diagram-3"></i> Lineage (D3)
        </button>
        <!-- The toggle for top 10 -->
        <button id="lineage-top10-button" type="button" class="btn btn-outline-secondary">
          Top 10 Only
        </button>
      </div>
    </form>
  `;

  render([tables, ...(schema.length ? [html`<div class="text-center my-3">${loading}</div>`, queryForm()] : [])], $tablesContainer);

  if (!schema.length) return;

  const $query = $tablesContainer.querySelector("#query");
  $query.scrollIntoView({ behavior: "smooth", block: "center" });
  $query.focus();

  // Show recommended questions from LLM
  DB.questions().then(({ questions, error }) => {
    if (error) return notify("danger", "Error", JSON.stringify(error));
    render(
      [
        tables,
        html`
          <div class="mx-auto narrative my-3">
            <h2 class="h6">Sample questions</h2>
            <ul>
              ${questions.map((q) => html`<li><a href="#" class="question">${q}</a></li>`)}
            </ul>
          </div>
        `,
        queryForm(),
      ],
      $tablesContainer
    );
    $tablesContainer.querySelector("#query").focus();
  });
}

//--------------------------------------------------------------------
// 8. Handle question submission + lineage button + top 10 toggle
$tablesContainer.addEventListener("click", async (e) => {
  // Handle sample question clicks
  const $question = e.target.closest(".question");
  if ($question) {
    e.preventDefault();
    $tablesContainer.querySelector("#query").value = $question.textContent;
    $tablesContainer.querySelector('form button[type="submit"]').click();
  }

  // Handle "Lineage (D3)" button
  const $lineageD3Button = e.target.closest("#lineage-d3-button");
  if ($lineageD3Button) {
    render("", $chartCode);
    try {
      drawD3Lineage(); // Draw the graph based on current filters
    } catch (err) {
      notify("danger", "Error", `Failed to build lineage diagram: ${err.message}`);
      console.error(err);
    }
  }

  // Handle "Top 10 Only" toggle button
  const $lineageTop10Button = e.target.closest("#lineage-top10-button");
  if ($lineageTop10Button) {
    showTop10 = !showTop10; // Toggle the flag
    // Update button text to reflect current state
    $lineageTop10Button.textContent = showTop10 ? "Show All Nodes" : "Top 10 Only";
    // Re-draw the lineage graph with the new flag
    drawD3Lineage();
  }
});

// Listen for form submissions (questions)
$tablesContainer.addEventListener("submit", async (e) => {
  e.preventDefault();
  const formData = new FormData(e.target);
  const userQuery = formData.get("query");

  render(html`<div class="text-center my-3">${loading}</div>`, $sql);
  render("", $result);

  // Ask LLM to generate SQL
  const resultText = await llm({
    system: `You are an expert SQLite query writer. The user has a SQLite dataset.

${DB.context}

This is their SQLite schema:

${DB.schema()
      .map(({ sql }) => sql)
      .join("\n\n")}

Answer the user's question following these steps:

1. Guess their objective in asking this.
2. Describe the steps to achieve this objective in SQL.
3. Write SQL to answer the question. Use SQLite syntax.

Replace generic filter values (e.g. "a location", "specific region", etc.) by querying a random value from data.
Always use [Table].[Column].`,
    user: userQuery,
  });

  // Render the LLM's text
  render(html`${unsafeHTML(marked.parse(resultText))}`, $sql);

  // Try to extract the SQL from code fences
  const match = resultText.match(/```.*?\n([\s\S]*?)```/);
  const sql = match ? match[1] : resultText;

  try {
    const data = db.exec(sql, { rowMode: "object" });
    if (data.length > 0) {
      latestQueryResult = data;
      // Render result table + download + chart
      const actions = html`
        <div class="row align-items-center g-2">
          <div class="col-auto">
            <button id="download-button" type="button" class="btn btn-primary">
              <i class="bi bi-filetype-csv"></i> Download CSV
            </button>
          </div>
          <div class="col">
            <input
              type="text"
              id="chart-input"
              name="chart-input"
              class="form-control"
              placeholder="Describe what you want to chart"
              value="Draw the most appropriate chart to visualize this data"
            />
          </div>
          <div class="col-auto">
            <button id="chart-button" type="button" class="btn btn-primary">
              <i class="bi bi-bar-chart-line"></i> Draw Chart
            </button>
          </div>
        </div>
      `;
      const tableHtml = renderTable(data.slice(0, 100));
      render([actions, tableHtml], $result);
    } else {
      render(html`<p>No results found.</p>`, $result);
    }
  } catch (err) {
    render(html`<div class="alert alert-danger">${err.message}</div>`, $result);
    console.error(err);
  }
});

//--------------------------------------------------------------------
// 9. Additional actions in the result area
$result.addEventListener("click", async (e) => {
  const $downloadButton = e.target.closest("#download-button");
  if ($downloadButton && latestQueryResult.length > 0) {
    download(dsvFormat(",").format(latestQueryResult), "datachat.csv", "text/csv");
  }

  const $chartButton = e.target.closest("#chart-button");
  if ($chartButton && latestQueryResult.length > 0) {
    const system = `Write JS code to draw a ChartJS chart.
Write the code inside a \`\`\`js code fence.
\`Chart\` is already imported.
Data is ALREADY available as \`data\`, an array of objects. Do not create it. Just use it.
Render inside <canvas id="chart"> like this:
\`\`\`js
return new Chart(
  document.getElementById("chart"),
  {
    type: "bar",
    data: {
      labels: [...],
      datasets: [{
        label: "Dataset",
        data: [...],
        backgroundColor: "rgba(75, 192, 192, 0.2)",
        borderColor: "rgba(75, 192, 192, 1)",
        borderWidth: 1
      }]
    },
    options: {
      scales: {
        y: { beginAtZero: true }
      }
    }
  }
)
\`\`\`
`;

    const user = `
Question: ${$tablesContainer.querySelector('[name="query"]').value}

// First 3 rows of result
data = ${JSON.stringify(latestQueryResult.slice(0, 3))}

// IMPORTANT: ${$result.querySelector("#chart-input").value}
`;
    render(loading, $chartCode);
    const chartResp = await llm({ system, user });
    render(html`${unsafeHTML(marked.parse(chartResp))}`, $chartCode);
    const codeMatch = chartResp.match(/```js\n([\s\S]*?)\n```/);
    if (!codeMatch) {
      notify("danger", "Error", "Could not generate chart code");
      return;
    }
    try {
      const drawChart = new Function("Chart", "data", codeMatch[1]);
      if (latestChart) latestChart.destroy();
      latestChart = drawChart(Chart, latestQueryResult);
    } catch (error) {
      notify("danger", "Error", `Failed to draw chart: ${error.message}`);
      console.error(error);
    }
  }
});

//--------------------------------------------------------------------
// 10. Load Categories into Dropdown Checkboxes
function loadCategories() {
  const categories = db.exec(`
    SELECT DISTINCT category
    FROM bank_datasets
    WHERE category IS NOT NULL
    ORDER BY category
  `, { rowMode: "array" });
  // categories will be an array of rows, e.g. [[ 'Loans' ], [ 'Deposits' ], ...]

  // Populate the <li id="category-checkboxes">
  const $checkboxesContainer = document.getElementById("category-checkboxes");

  // Remove existing category checkboxes except "All Categories"
  $checkboxesContainer.innerHTML = "";

  // Append each unique category as a checkbox
  categories.forEach(row => {
    const catValue = row[0];
    const checkboxItem = document.createElement("li");
    checkboxItem.classList.add("dropdown-item");

    const checkboxDiv = document.createElement("div");
    checkboxDiv.classList.add("form-check");

    const checkbox = document.createElement("input");
    checkbox.classList.add("form-check-input", "category-checkbox");
    checkbox.type = "checkbox";
    checkbox.value = catValue;
    checkbox.id = `category-${catValue}`;
    checkbox.checked = true; // Default to checked

    const label = document.createElement("label");
    label.classList.add("form-check-label");
    label.htmlFor = `category-${catValue}`;
    label.textContent = catValue;

    checkboxDiv.appendChild(checkbox);
    checkboxDiv.appendChild(label);
    checkboxItem.appendChild(checkboxDiv);
    $checkboxesContainer.appendChild(checkboxItem);
  });

  // Update the dropdown button text
  updateDropdownButton();
}

//--------------------------------------------------------------------
// Update Dropdown Button Text Based on Selected Categories
function updateDropdownButton() {
  const $dropdownButton = document.getElementById("categoryDropdown");
  const selectedCategories = Array.from(document.querySelectorAll(".category-checkbox:checked"))
    .map(checkbox => checkbox.value)
    .filter(value => value !== ""); // Exclude "All Categories"

  if (selectedCategories.length === 0 || selectedCategories.length === document.querySelectorAll(".category-checkbox").length) {
    $dropdownButton.textContent = "All Categories";
  } else if (selectedCategories.length === 1) {
    $dropdownButton.textContent = selectedCategories[0];
  } else {
    $dropdownButton.textContent = `${selectedCategories.length} Categories Selected`;
  }
}

//--------------------------------------------------------------------
// 11. Listen for changes to category checkboxes within the dropdown
document.getElementById("category-filter-container").addEventListener("change", (e) => {
  const $target = e.target;

  // Handle "All Categories" checkbox
  if ($target.id === "category-all") {
    const isChecked = $target.checked;
    // Toggle all other checkboxes based on "All Categories"
    document.querySelectorAll(".category-checkbox").forEach(checkbox => {
      checkbox.checked = isChecked;
    });
  } else {
    // If any individual category is unchecked, uncheck "All Categories"
    if (!$target.checked) {
      const $all = document.getElementById("category-all");
      if ($all.checked) $all.checked = false;
    } else {
      // If all individual categories are checked, check "All Categories"
      const allChecked = Array.from(document.querySelectorAll(".category-checkbox"))
        .every(checkbox => checkbox.checked);
      if (allChecked) {
        document.getElementById("category-all").checked = true;
      }
    }
  }

  // Update the dropdown button text
  updateDropdownButton();

  // Collect selected categories
  const selectedCategories = Array.from(document.querySelectorAll(".category-checkbox:checked"))
    .map(checkbox => checkbox.value)
    .filter(value => value !== "");

  // If "All Categories" is selected or no categories are selected, set selectedCategories to empty array to indicate no filter
  const finalSelectedCategories = (document.getElementById("category-all").checked || selectedCategories.length === 0) ? [] : selectedCategories;

  // Redraw the lineage diagram with the selected categories
  drawD3Lineage(finalSelectedCategories);
});

// Prevent dropdown from closing when clicking inside the checkbox list
document.getElementById("category-checkboxes").addEventListener("click", (e) => {
  e.stopPropagation();
});

//--------------------------------------------------------------------
// 12. Update drawD3Lineage to accept multiple categories
function drawD3Lineage(selectedCategories = []) {
  const container = document.getElementById("d3-lineage");
  container.innerHTML = "";

  // 1) Query lineage, datasets, and jobs
  const lineageRows = db.exec(
    `SELECT lineage_id, source_dataset, target_dataset, job_id FROM bank_lineage`,
    { rowMode: "object" }
  );

  // 2) Query datasets with optional category filter
  let datasetQuery = `
    SELECT dataset_id, dataset_name, category
    FROM bank_datasets
  `;

  if (Array.isArray(selectedCategories) && selectedCategories.length > 0) {
    const sanitizedCategories = selectedCategories.map(cat => `'${cat.replace("'", "''")}'`).join(", ");
    datasetQuery += `
      WHERE category IN (${sanitizedCategories})
    `;
  }

  const datasetRows = db.exec(datasetQuery, { rowMode: "object" });

  // 3) Build lookups
  const datasetMap = {};
  datasetRows.forEach((ds) => {
    datasetMap[ds.dataset_id] = ds.dataset_name || ds.dataset_id;
  });

  const jobMap = {};
  const jobRows = db.exec(
    `SELECT job_id, job_name FROM bank_jobs`,
    { rowMode: "object" }
  );
  jobRows.forEach((j) => {
    jobMap[j.job_id] = j.job_name || j.job_id;
  });

  // 4) Build a set of allowed dataset IDs
  const allowedIDs = new Set(datasetRows.map(r => r.dataset_id));

  // 5) Filter lineageRows to only those where both source and target are in allowedIDs
  const filteredLineage = lineageRows.filter(row =>
    allowedIDs.has(row.source_dataset) && allowedIDs.has(row.target_dataset)
  );

  // 6) Build nodes from filtered lineage
  const nodesMap = new Map();
  filteredLineage.forEach(row => {
    if (!nodesMap.has(row.source_dataset)) {
      nodesMap.set(row.source_dataset, {
        id: row.source_dataset,
        name: datasetMap[row.source_dataset] || row.source_dataset,
        degree: 0
      });
    }
    if (!nodesMap.has(row.target_dataset)) {
      nodesMap.set(row.target_dataset, {
        id: row.target_dataset,
        name: datasetMap[row.target_dataset] || row.target_dataset,
        degree: 0
      });
    }
  });
  const nodes = Array.from(nodesMap.values());

  // 7) Build links
  const links = filteredLineage.map(row => ({
    source: row.source_dataset,
    target: row.target_dataset,
    job: jobMap[row.job_id] || row.job_id
  }));

  // 8) Compute degrees
  links.forEach(lnk => {
    nodesMap.get(lnk.source).degree++;
    nodesMap.get(lnk.target).degree++;
  });

  // 9) If showTop10 is true, filter nodes and links
  let finalNodes = nodes;
  let finalLinks = links;
  if (showTop10) {
    // Sort nodes by descending degree
    nodes.sort((a, b) => b.degree - a.degree);
    // Slice top 10
    const topNodes = new Set(nodes.slice(0, 10).map(d => d.id));
    finalNodes = nodes.slice(0, 10);
    // Filter links to only those connecting top nodes
    finalLinks = links.filter(lnk => topNodes.has(lnk.source) && topNodes.has(lnk.target));
  }

  // 10) Draw the D3 graph
  drawGraph(finalNodes, finalLinks, container);
}

//--------------------------------------------------------------------
// 13. The actual D3 force layout logic with rectangular nodes and labels inside
function drawGraph(nodes, links, container) {
  const width = 1100;
  const height = 1200;

  const svg = d3
    .select(container)
    .append("svg")
    .attr("width", width)
    .attr("height", height);

  // Define arrow markers for graph links
  svg.append("defs").append("marker")
    .attr("id", "arrowhead")
    .attr("viewBox", "-0 -5 10 10")
    .attr("refX", 25) // Adjust this value to control the position of the arrow
    .attr("refY", 0)
    .attr("orient", "auto")
    .attr("markerWidth", 6)
    .attr("markerHeight", 6)
    .attr("xoverflow", "visible")
    .append("svg:path")
    .attr("d", "M 0,-5 L 10 ,0 L 0,5")
    .attr("fill", "#aaa")
    .style("stroke","none");

  const simulation = d3
    .forceSimulation(nodes)
    .force("link", d3.forceLink(links).id(d => d.id).distance(150))
    .force("charge", d3.forceManyBody().strength(-100))
    .force("center", d3.forceCenter(width / 2, height / 2))
    .force("collision", d3.forceCollide().radius(d => getRectWidth(d.name) / 2 + 20))
    .on("tick", ticked);

  // Draw link lines with arrowheads
  const link = svg.selectAll("line.link")
    .data(links)
    .enter()
    .append("line")
    .attr("class", "link")
    .attr("stroke", "#aaa")
    .attr("stroke-width", 2)
    .attr("marker-end", "url(#arrowhead)"); // Attach arrowhead

  // Optional link labels for job names
  const linkLabel = svg.selectAll("text.link-label")
    .data(links)
    .enter()
    .append("text")
    .attr("font-size", "12px")
    .attr("fill", "#555")
    .text(d => d.job);

  // Draw node groups (rectangles with text inside)
  const node = svg.selectAll("g.node")
    .data(nodes)
    .enter()
    .append("g")
    .attr("class", "node")
    .call(
      d3.drag()
        .on("start", dragStarted)
        .on("drag", dragged)
        .on("end", dragEnded)
    );

  // Append rectangles to nodes
  node.append("rect")
    .attr("width", d => getRectWidth(d.name))
    .attr("height", 30)
    .attr("x", d => -getRectWidth(d.name) / 2)
    .attr("y", -15)
    .attr("fill", "#69b3a2")
    .attr("stroke", "#333")
    .attr("rx", 5) // Rounded corners
    .attr("ry", 5);

  // Append text to nodes
  node.append("text")
    .attr("text-anchor", "middle")
    .attr("dy", 5)
    .attr("fill", "#fff")
    .attr("pointer-events", "none") // Make text ignore mouse events
    .attr("font-size", "12px")
    .text(d => d.name);

  function ticked() {
    link
      .attr("x1", d => d.source.x)
      .attr("y1", d => d.source.y)
      .attr("x2", d => d.target.x)
      .attr("y2", d => d.target.y);

    linkLabel
      .attr("x", d => (d.source.x + d.target.x) / 2)
      .attr("y", d => (d.source.y + d.target.y) / 2);

    node
      .attr("transform", d => `translate(${d.x},${d.y})`);
  }

  function dragStarted(event, d) {
    if (!event.active) simulation.alphaTarget(0.3).restart();
    d.fx = d.x;
    d.fy = d.y;
  }
  function dragged(event, d) {
    d.fx = event.x;
    d.fy = event.y;
  }
  function dragEnded(event, d) {
    if (!event.active) simulation.alphaTarget(0);
    d.fx = null;
    d.fy = null;
  }

  // Helper function to calculate rectangle width based on text length
  function getRectWidth(text) {
    const context = document.createElement("canvas").getContext("2d");
    context.font = "12px sans-serif";
    const metrics = context.measureText(text);
    return Math.max(80, metrics.width + 20); // Minimum width 80px
  }
}

//--------------------------------------------------------------------
// 14. Utility functions
function notify(cls, title, message) {
  $toast.querySelector(".toast-title").textContent = title;
  $toast.querySelector(".toast-body").textContent = message;
  const $toastHeader = $toast.querySelector(".toast-header");
  $toastHeader.classList.remove(
    "text-bg-success",
    "text-bg-danger",
    "text-bg-warning",
    "text-bg-info"
  );
  $toastHeader.classList.add(`text-bg-${cls}`);
  toast.show();
}

async function llm({ system, user, schema }) {
  const response = await fetch("https://llmfoundry.straive.com/openai/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}:datachat` },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      temperature: 0,
      ...(schema
        ? {
            response_format: {
              type: "json_schema",
              json_schema: { name: "response", strict: true, schema },
            },
          }
        : {}),
    }),
  }).then((r) => r.json());
  if (response.error) return response;
  const content = response.choices?.[0]?.message?.content;
  try {
    return schema ? JSON.parse(content) : content;
  } catch (e) {
    return { error: e };
  }
}

function renderTable(data) {
  if (!data.length) return html`<p>No rows.</p>`;
  const columns = Object.keys(data[0]);
  return html`
    <table class="table table-striped table-hover">
      <thead>
        <tr>${columns.map((col) => html`<th>${col}</th>`)}</tr>
      </thead>
      <tbody>
        ${data.map(
          (row) => html`
            <tr>
              ${columns.map((col) => html`<td>${row[col]}</td>`)}
            </tr>
          `
        )}
      </tbody>
    </table>
  `;
}

function download(content, filename, type) {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

//--------------------------------------------------------------------
// 15. Load Categories on Page Load
// Ensure categories are loaded when the page first loads
document.addEventListener("DOMContentLoaded", () => {
  // Initially hide the category filter container
  $categoryFilterContainer.style.display = "none";
});
