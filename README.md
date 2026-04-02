# Redmine MCP Server TCI

A TCI-specific Redmine MCP (Model Context Protocol) server with **multi-account support** and **Excel-based workflow rules**.

## Features

### 1. **Multi-Account Support** 👥
- Users authenticate once per session with their own Redmine credentials
- Each session maintains isolated credential storage
- Credentials are encrypted at rest using AES-256-CBC
- 24-hour session expiration with automatic cleanup
- No shared account required - each user works with their own permissions

### 2. **Excel-Based Workflow Configuration** 📊
- Define ticket workflow rules in a simple Excel format
- Supports:
  - **Status transitions**: Define allowed transitions per tracker
  - **Field requirements**: Specify which fields must be filled
  - **Custom validators**: Regex, min/max length, enum validation
  - **Automated actions**: Email notifications, field assignments, etc.
- Load workflow definition on startup
- Real-time validation of ticket transitions
- Analyze ticket requirements from ad-hoc Excel files (path or base64 upload)

### 3. **Full Redmine Integration** 🔗
- Get and list issues
- View issue details with comment history
- Create git branches from tickets
- Update ticket status with validation
- Add comments to tickets
- Manage projects in MongoDB

## Quick Start

### Prerequisites
- Node.js 18+ (or 16+ with warnings)
- npm or yarn
- Redmine server running and accessible
- (Optional) MongoDB for multi-repo project management
- (Optional) Excel file with workflow rules

### Installation

```bash
# 1. Install dependencies
npm install

# 2. Copy environment template
cp .env.example .env

# 3. Configure your Redmine server in .env
# Set REDMINE_TCI_URL, REDMINE_USERNAME (fallback), REDMINE_PASSWORD
```

### Configuration

Edit `.env` with your settings:

```env
# Required
REDMINE_TCI_URL=https://your-redmine.example.com

# Server
TRANSPORT=sse                    # or "stdio"
PORT=3000

# Workflow (optional)
WORKFLOW_EXCEL_PATH=./workflow.xlsx
ENFORCE_STRICT_WORKFLOW=false   # Set to true to require all transitions to have rules

# MongoDB (optional)
MONGODB_URI_MCP_TCI=mongodb://localhost:27017/redmine-mcp

# Security
ALLOWED_ORIGINS=http://localhost:3000,http://localhost:5173
```

### Running the Server

```bash
# Build TypeScript
npm run build

# Start server
npm start

# Or development mode with auto-reload
npm run dev
```

### Health Check

```bash
curl http://localhost:3000/health
```

Response:
```json
{
  "status": "ok",
  "transport": "sse",
  "version": "1.0.0",
  "mongo": true,
  "workflow": true,
  "workflowRules": 24
}
```

## Usage Guide

### 1. Connect with User Credentials

**Establish SSE session:**
```bash
curl -X GET "http://localhost:3000/sse?username=john&password=secret"
```

Response:
```json
{
  "type": "connection_info",
  "sessionId": "550e8400-e29b-41d4-a716-446655440000",
  "credentialsValid": true,
  "credentialSessionId": "550e8400-e29b-41d4-a716-446655440001"
}
```

### 2. Call MCP Tools

**Example: Get issue details**
```
Tool: get_issue
Arguments:
  - issue_id: 123
  - session_id: "550e8400-e29b-41d4-a716-446655440001" (optional)
```

**Example: Validate ticket transition**
```
Tool: validate_ticket_transition
Arguments:
  - issue_id: 123
  - to_status_id: 2
  - session_id: "550e8400-e29b-41d4-a716-446655440001"
```

**Example: Build coding brief from ticket + Excel**
```
Tool: analyze_ticket_with_excel
Arguments:
  - issue_id: 123
  - excel_path: "./examples/ui-requirement.xlsx"
  - include_journals: true
```

Or send file content directly:
```
Tool: analyze_ticket_with_excel
Arguments:
  - issue_id: 123
  - excel_base64: "UEsDBBQAAAAIA..."
  - excel_file_name: "ui-requirement.xlsx"
```

### 3. Available Tools

#### Redmine Tools
- `get_issue` - Get full issue details
- `list_issues` - Search issues with filters
- `create_branch_for_issue` - Create git branches from tickets

#### Workflow Tools
- `validate_ticket_transition(issue_id, to_status_id)` - Check if transition is allowed
- `get_available_transitions(issue_id)` - List valid next statuses
- `get_ticket_workflow_rules(tracker_name)` - Show rules for a tracker

#### Requirement Analysis Tools
- `analyze_ticket_with_excel(issue_id, excel_path|excel_base64)` - Merge ticket + Excel requirement data into a coding-ready brief for AI/Cursor

## Excel Workflow Configuration

### File Format

Three sheets required:

1. **Rules** - Define transitions and field requirements
2. **Validators** - Custom validation rules
3. **Actions** - Automated actions (email, field updates, etc.)

### Example

**Rules Sheet:**
```
tracker | status_from | status_to  | required_fields    | validators     | actions
--------|-------------|------------|--------------------|----|---
Bug     | Open        | InProgress | assignee,due_date  | CheckDueDate | notify
Task    | Draft       | Review     |                    |              | assign_reviewer
        |             | Closed     |                    |              |
```

**Validators Sheet:**
```
validator_name | field     | rule_type | value  | error_message
----------------|-----------|-----------|--------|---------------------------
CheckDueDate    | due_date  | min_length| 1      | Due date required for bugs
ValidateDesc    | description| max_length| 500    | Max 500 characters
```

**Actions Sheet:**
```
action_name     | action_type | parameters
-----------------|------------|--------------------------------------
notify          | notify     | {"users": ["assignee"]}
assign_reviewer | assign_field| {"field": "assignee", "value": "reviewer"}
```

See `docs/workflow-excel-format.md` for complete documentation.

## Architecture

### Project Structure
```
src/
├── index.ts                 # Main MCP server
├── redmine-client.ts        # Enhanced Redmine API client
├── excel-parser.ts          # Parse Excel workflow files
├── workflow-engine.ts       # Enforce workflow rules
├── credential-session.ts    # Session credential management
├── types.ts                 # TypeScript interfaces
├── middleware.ts            # Express middleware
├── mongo-client.ts          # MongoDB integration
└── git-helper.ts            # Git utilities

docs/
└── workflow-excel-format.md # Excel format specification

examples/
└── sample-workflow.xlsx      # Example workflow file
```

### Key Components

**RedmineClient (Enhanced)**
- Supports both static credentials (fallback) and per-session credentials
- Same API as original mcp-server
- Dynamically updates auth for each request

**CredentialSessionManager**
- In-memory session storage with encryption
- Auto-cleanup of expired sessions (24-hour default)
- Multiple concurrent user sessions

**WorkflowEngine**
- Validates status transitions against rules
- Checks required fields
- Runs custom validators
- Returns available actions

**ExcelParser**
- Parses three-sheet Excel workbook
- Validates file structure
- Handles field mappings

## Development

### Build
```bash
npm run build
```

### Lint
```bash
npm run lint
npm run lint:fix
```

### Format
```bash
npm run format
```

### Pre-commit Hooks
This project uses Husky and lint-staged to automatically lint and format staged files before commit:
```bash
# Hooks are installed automatically with npm install
# Manually trigger pre-commit checks
npm run pre-commit
```

## Development Tools

### ESLint ✅
- **Configuration**: `eslint.config.js`
- **Supports**: TypeScript files with strict type checking
- **Rules**:
  - Type consistency checks
  - No unused variables (except underscore-prefixed)
  - Explicit type imports required
  - Limits console usage (only `console.error` and `console.warn`)

**Run linting:**
```bash
npm run lint              # Check all files
npm run lint:fix         # Auto-fix issues
```

### Prettier 🎨
- **Configuration**: `.prettierrc`
- **Format settings**:
  - 2-space indentation
  - Double quotes
  - Semicolons required
  - Trailing commas (ES5 compatible)
  - 100-character line width

**Run formatting:**
```bash
npm run format           # Format all files
```

### Docker 🐳
- **File**: `Dockerfile`
- **Multi-stage build** for optimized images
- **Base image**: `node:22-alpine` (lightweight)
- **Features**:
  - Production-ready image
  - Minimal dependencies (dev deps removed)
  - Pre-compiled TypeScript
  - Git included for version control

**Build Docker image:**
```bash
docker build -t redmine-mcp-server-tci .
```

**Run Docker container:**
```bash
docker run -d \
  --name redmine-mcp-server \
  -p 3000:3000 \
  --env-file .env.prod \
  -v /logs/redmine-mcp-server:/app/logs \
  --restart unless-stopped \
  redmine-mcp-server-tci:latest
```

**Telegram notifications** trigger on success/failure with build details

## Configuration Reference

### Environment Variables

| Variable | Type | Required | Description |
|----------|------|----------|-------------|
| `REDMINE_URL` | string | Yes | Redmine instance URL |
| `REDMINE_USERNAME` | string | No* | Fallback username |
| `REDMINE_PASSWORD` | string | No* | Fallback password |
| `TRANSPORT` | string | No | `stdio` or `sse` (default: `stdio`) |
| `PORT` | number | No | Server port (default: 3000) |
| `WORKFLOW_EXCEL_PATH` | string | No | Path to workflow Excel file |
| `ENFORCE_STRICT_WORKFLOW` | boolean | No | Require explicit rules for all transitions (default: false) |
| `MONGODB_URI` | string | No | MongoDB connection string |
| `ALLOWED_ORIGINS` | string | No | CORS allowed origins (comma-separated) |
| `MCP_AUTH_TOKEN` | string | No | Bearer token for SSE endpoints |
| `CREDENTIAL_ENCRYPTION_KEY` | string | No | 32-char encryption key for credentials |
| `GIT_REPO_PATH` | string | No | Fallback git repository path |
| `BRANCH_FORMAT` | string | No | `ticket-id` or `ticket-id-title` (default: `ticket-id-title`) |

*Required if using static credentials instead of per-session auth

## Security Considerations

1. **Credential Encryption**: User credentials are encrypted with AES-256-CBC
2. **Session Expiration**: Sessions expire after 24 hours
3. **HTTPS**: Use HTTPS in production for SSE connections
4. **Rate Limiting**: 200 requests per 15 minutes per client
5. **CORS**: Configure `ALLOWED_ORIGINS` to restrict access
6. **Helmet**: Security headers enabled by default

## Troubleshooting

### "Workflow definition not loaded"
- Check `WORKFLOW_EXCEL_PATH` points to valid file
- Verify Excel file has "Rules" sheet
- Check file permissions

### Credentials validation fails
- Verify Redmine URL is correct and accessible
- Check username/password in request
- Ensure user has API access enabled in Redmine

### Performance issues with large workflows
- Consider splitting workflow into multiple projects
- Use `ENFORCE_STRICT_WORKFLOW=false` to skip missing rules

## License

Same as parent mcp-server project

## Contributing

1. Follow existing code style (ESLint + Prettier configured)
2. Add tests for new features
3. Update documentation
4. Create PR with description

## Support & Resources

- **Redmine API Docs**: [Redmine API Documentation](https://www.redmine.org/projects/redmine/wiki/Rest_api)
- **MCP Specification**: [Model Context Protocol](https://modelcontextprotocol.io/)
- **TCI Documentation**: Internal project documentation

## Version

v1.0.0 - Initial release with multi-account support and Excel-based workflows

