// O que a interface vê das contas do agy: nenhum token sai do main.
export interface AntigravityAccount {
  id: string
  email: string
  active: boolean
}

export interface AntigravityAccountsView {
  accounts: AntigravityAccount[]
  // Há login no agy, mas a credencial não diz de qual conta é.
  activeUnknown: boolean
  // O Kora tirou o login do agy para uma conta nova entrar; a conta que estava ativa ficou guardada.
  adding: boolean
}
