export interface InitParams {
	cwd: string;
}

export interface InitResult {
	viewId: string;
}

export const initView = async (_params: InitParams): Promise<InitResult> => {
	throw new Error("not yet implemented");
};
