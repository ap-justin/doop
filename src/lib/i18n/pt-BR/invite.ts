import type { Catalog } from '..'

export const invite: Catalog['invite'] = {
  linkLine: 'Envie este link para {email}. Ele funciona uma vez e expira em 7 dias.',
  linkAria: 'Link de convite para {email}',
  copyLink: 'Copiar link',
  linkCopied: 'Link copiado',
  copyFailed: 'Não foi possível copiar — selecione o link e copie manualmente',
  waiting: 'Aguardando cadastro',
  revoke: 'Revogar',
  revokeAria: 'Revogar o convite de {email}',
  revokeFailed: 'não foi possível revogar o convite',
  invitedLink: '{email} foi convidado — envie o link abaixo',

  titleWorkspace: 'Entrar em {name}',
  titleCanvas: 'Abrir {name}',
  ledeWorkspace: '{inviter} convidou você para o workspace “{name}”.',
  ledeCanvas: '{inviter} convidou você para colaborar em “{name}”.',
  email: 'E-mail',
  name: 'Seu nome',
  password: 'Senha',
  passwordHint: 'Pelo menos 8 caracteres',
  create: 'Criar conta e entrar',
  creating: 'Criando sua conta…',
  failed: 'Não foi possível aceitar o convite',

  existsTitle: 'Você já tem uma conta',
  existsText: 'Já existe uma conta com {email}. Entre para participar.',
  signIn: 'Entrar',
  joining: 'Entrando…',
  wrongAccount: 'Você está conectado como {current}, mas este convite é para {email}.',
  signOut: 'Sair',

  invalidTitle: 'Este link de convite não é mais válido',
  invalidText: 'Peça um novo.',
}
