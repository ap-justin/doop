import type { Catalog } from '..'

export const agentKeys: Catalog['agentKeys'] = {
  loadFailed: 'Não foi possível carregar suas chaves',
  createFailed: 'Não foi possível criar essa chave',
  revokeFailed: 'Não foi possível revogar essa chave',

  title: 'Chaves de agente',
  description:
    'Credenciais bearer para o endpoint MCP, para agentes que não conseguem abrir um navegador para entrar — um workflow do Mastra, n8n, CI. Uma chave age como você: tudo o que ela desenha é atribuído a você, e ela alcança exatamente os canvases que você alcança. Revogar corta o acesso na hora.',
  newKeyRow: 'Nova chave',
  creating: 'Criando…',
  createKey: 'Criar chave',
  namePlaceholder: 'O que vai usá-la, ex.: mastra-prod',
  nameAria: 'Nome da chave de agente',
  accessRow: 'Acesso',
  accessAria: 'Acesso da chave de agente',
  scopeFull: 'Acesso total',
  scopeComment: 'Ler e comentar',
  scopeFullHint: 'Pode usar todas as ferramentas: desenhar, editar e excluir, além de ler e comentar.',
  scopeCommentHint: 'Pode ler canvases e responder ou resolver comentários. Não pode criar nem alterar mais nada.',

  canvasesRow: 'Canvases',
  limitAll: 'Todos os canvases',
  limitSome: 'Só alguns workspaces',
  limitAria: 'Canvases que a chave alcança',
  limitPickOne: 'Escolha pelo menos um workspace.',
  limitedTo: 'Só em {names}',
  limitGroupAria: 'Workspaces que a chave alcança',
  limitLoadFailed: 'Não foi possível carregar seus workspaces',
  limitNone: 'Nenhum workspace disponível',

  yourNewKey: 'Sua nova chave',
  copyNow: 'Copie agora — ela é mostrada uma única vez e guardada como hash.',
  headlessConfigLabel: 'Configuração MCP para um cliente sem interface',

  revokeAria: 'Revogar {name}',
  revoke: 'Revogar',
  createdLastUsed: 'criada {created} · usada por último {used}',
  createdNeverUsed: 'criada {created} · nunca usada',
  noKeysRow: 'Nenhuma chave ainda',
  noKeysNote: 'Clientes interativos (Claude Code, Codex) não precisam de uma — eles entram com OAuth.',

  revokeConfirmTitle: 'Revogar “{name}”?',
  revokeConfirmDescription: 'Os agentes que a usam perdem o acesso na hora.',
  revokeConfirm: 'Revogar chave',
}
