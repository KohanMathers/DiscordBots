interface At {
  line: number;
  column: number;
}

export type Expr =
  | (At & { kind: 'Number'; value: number })
  | (At & { kind: 'String'; value: string })
  | (At & { kind: 'Boolean'; value: boolean })
  | (At & { kind: 'Null' })
  | (At & { kind: 'List'; elements: Expr[] })
  | (At & { kind: 'Map'; entries: Array<{ key: string; value: Expr }> })
  | (At & { kind: 'Identifier'; name: string })
  | (At & { kind: 'Member'; object: Expr; property: string })
  | (At & { kind: 'Index'; object: Expr; index: Expr })
  | (At & { kind: 'Binary'; left: Expr; op: string; right: Expr })
  | (At & { kind: 'Unary'; op: string; operand: Expr })
  | (At & { kind: 'Assign'; target: Expr; value: Expr })
  | (At & { kind: 'Call'; callee: Expr; args: Expr[] })
  | (At & { kind: 'NewScope'; args: Expr[] });

export type Stmt =
  | (At & { kind: 'Let'; name: string; value: Expr; isConst: boolean })
  | (At & { kind: 'Func'; name: string; params: string[]; body: Stmt[] })
  | (At & { kind: 'Return'; value: Expr | null })
  | (At & { kind: 'If'; condition: Expr; then: Stmt[]; else: Stmt[] | null })
  | (At & { kind: 'While'; condition: Expr; body: Stmt[] })
  | (At & { kind: 'For'; variable: string; iterable: Expr; body: Stmt[] })
  | (At & { kind: 'Break' })
  | (At & { kind: 'Continue' })
  | (At & { kind: 'Try'; body: Stmt[]; errorVar: string; handler: Stmt[] })
  | (At & { kind: 'OnEvent'; event: string; body: Stmt[] })
  | (At & { kind: 'Expr'; expr: Expr });

export interface Program {
  body: Stmt[];
}
