<#
.SYNOPSIS
    Gestor e instalador de subagentes para Claude Code en Postava.
    Descarga agentes directamente desde el repositorio comunitario VoltAgent/awesome-claude-code-subagents en GitHub.

.EXAMPLE
    .\scripts\install-agent.ps1 -List
    .\scripts\install-agent.ps1 -Search "docker"
    .\scripts\install-agent.ps1 -Install "docker-expert" -Category "03-infrastructure"
    .\scripts\install-agent.ps1 -SearchAndInstall "seo-specialist"
#>

[CmdletBinding()]
param (
    [switch]$List,
    [string]$Search,
    [string]$Install,
    [string]$Category,
    [string]$SearchAndInstall
)

$RepoBase = "https://raw.githubusercontent.com/VoltAgent/awesome-claude-code-subagents/main"
$TargetDir = Join-Path $PSScriptRoot "..\.claude\agents"
$LocalScratch = "C:\Users\luis.soto\.gemini\antigravity\brain\8cc78b8c-9e85-48b7-9047-f81a0169a96e\scratch\awesome-agents\categories"

if (-not (Test-Path $TargetDir)) {
    New-Item -ItemType Directory -Force -Path $TargetDir | Out-Null
}

$Categories = @{
    "01-core-development"     = @("api-designer", "auth-integration-engineer", "backend-developer", "design-bridge", "electron-pro", "frontend-developer", "fullstack-developer", "graphql-architect", "microservices-architect", "mobile-developer", "ui-designer", "webhook-engineer", "websocket-engineer")
    "02-language-specialists" = @("angular-architect", "cpp-pro", "csharp-developer", "django-developer", "dotnet-core-expert", "dotnet-framework-4.8-expert", "elixir-expert", "expo-react-native-expert", "fastapi-developer", "flutter-expert", "golang-pro", "java-architect", "javascript-pro", "kotlin-specialist", "laravel-specialist", "nextjs-developer", "node-specialist", "php-pro", "powershell-5.1-expert", "powershell-7-expert", "python-pro", "rails-expert", "react-specialist", "rust-engineer", "spring-boot-engineer", "sql-pro", "swift-expert", "symfony-specialist", "typescript-pro", "vue-expert")
    "03-infrastructure"       = @("azure-infra-engineer", "cloud-architect", "database-administrator", "deployment-engineer", "devops-engineer", "devops-incident-responder", "docker-expert", "incident-responder", "kubernetes-specialist", "network-engineer", "platform-engineer", "security-engineer", "sre-engineer", "terraform-engineer", "terragrunt-expert", "windows-infra-admin")
    "04-quality-security"     = @("accessibility-tester", "ad-security-reviewer", "ai-writing-auditor", "architect-reviewer", "chaos-engineer", "code-reviewer", "compliance-auditor", "debugger", "error-detective", "gdpr-ccpa-compliance", "penetration-tester", "performance-engineer", "powershell-security-hardening", "qa-expert", "security-auditor", "test-automator", "ui-ux-tester")
    "05-data-ai"              = @("ai-engineer", "data-analyst", "data-engineer", "data-scientist", "database-optimizer", "llm-architect", "machine-learning-engineer", "ml-engineer", "mlops-engineer", "nlp-engineer", "postgres-pro", "prompt-engineer", "reinforcement-learning-engineer")
    "06-developer-experience" = @("build-engineer", "cli-developer", "dependency-manager", "docs-drift-editor", "documentation-engineer", "dx-optimizer", "git-workflow-manager", "legacy-modernizer", "mcp-developer", "powershell-module-architect", "powershell-ui-architect", "readme-generator", "refactoring-specialist", "slack-expert", "tooling-engineer", "visual-asset-generator")
    "07-specialized-domains"  = @("api-documenter", "blockchain-developer", "email-deliverability-engineer", "embedded-systems", "fintech-engineer", "game-developer", "healthcare-admin", "hipaa-compliance", "iot-engineer", "m365-admin", "mobile-app-developer", "payment-integration", "quant-analyst", "risk-manager", "seo-specialist", "x-api-integration")
    "08-business-product"     = @("assumption-mapping", "backlog-grooming", "business-analyst", "content-marketer", "content-quality-editor", "customer-success-manager", "growth-loops", "landing-page-copywriter", "legal-advisor", "license-engineer", "product-manager", "project-manager", "sales-engineer", "scrum-master", "technical-writer", "ux-researcher", "wordpress-master")
    "09-meta-orchestration"   = @("agent-installer", "agent-organizer", "codebase-orchestrator", "context-manager", "error-coordinator", "it-ops-orchestrator", "knowledge-synthesizer", "memory-curator", "multi-agent-coordinator", "performance-monitor", "task-distributor", "workflow-orchestrator")
    "10-research-analysis"    = @("ab-test-analysis", "cohort-analysis", "competitive-analyst", "data-researcher", "first-principles-thinking", "market-researcher", "project-idea-validator", "research-analyst", "scientific-literature-researcher", "search-specialist", "trend-analyst")
}

function Find-CategoryForAgent([string]$AgentName) {
    foreach ($cat in $Categories.Keys) {
        if ($Categories[$cat] -contains $AgentName) {
            return $cat
        }
    }
    return $null
}

function Install-Subagent([string]$AgentName, [string]$Cat) {
    $cleanName = $AgentName.Replace(".md", "")
    if (-not $Cat) {
        $Cat = Find-CategoryForAgent $cleanName
    }
    if (-not $Cat) {
        Write-Host "Error: No se encontró la categoría para '$cleanName'." -ForegroundColor Red
        return
    }

    $destFile = Join-Path $TargetDir "$cleanName.md"
    Write-Host "Instalando subagente '$cleanName' desde $Cat..." -ForegroundColor Cyan

    $localPath = Join-Path $LocalScratch "$Cat\$cleanName.md"
    if (Test-Path $localPath) {
        Copy-Item -Path $localPath -Destination $destFile -Force
        Write-Host "Instalado con éxito en: $destFile (origen local)" -ForegroundColor Green
        return
    }

    $url = "$RepoBase/categories/$Cat/$cleanName.md"
    try {
        Invoke-RestMethod -Uri $url -OutFile $destFile
        Write-Host "Descargado e instalado con éxito en: $destFile (origen GitHub)" -ForegroundColor Green
    } catch {
        Write-Host "Error al descargar desde GitHub: $_" -ForegroundColor Red
    }
}

if ($List) {
    Write-Host "`n=== Catálogo de Subagentes Disponibles (+160) ===`n" -ForegroundColor Yellow
    foreach ($cat in ($Categories.Keys | Sort-Object)) {
        Write-Host "[$cat]" -ForegroundColor Cyan
        Write-Host ($Categories[$cat] -join ", ") -ForegroundColor White
        Write-Host ""
    }
    exit 0
}

if ($Search) {
    Write-Host "`nBuscando agentes con '$Search':`n" -ForegroundColor Yellow
    $found = 0
    foreach ($cat in $Categories.Keys) {
        foreach ($agent in $Categories[$cat]) {
            if ($agent -like "*$Search*") {
                Write-Host "  - $agent (Categoría: $cat)" -ForegroundColor Green
                $found++
            }
        }
    }
    if ($found -eq 0) {
        Write-Host "No se encontraron agentes coincidentes." -ForegroundColor DarkYellow
    }
    exit 0
}

if ($Install) {
    Install-Subagent $Install $Category
    exit 0
}

if ($SearchAndInstall) {
    Install-Subagent $SearchAndInstall
    exit 0
}

Write-Host "Uso: .\scripts\install-agent.ps1 [-List] [-Search <término>] [-SearchAndInstall <nombre-agente>]" -ForegroundColor Cyan
