export namespace buildinfo {
	
	export class Info {
	    version: string;
	    commit: string;
	    date: string;
	
	    static createFrom(source: any = {}) {
	        return new Info(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.version = source["version"];
	        this.commit = source["commit"];
	        this.date = source["date"];
	    }
	}

}

export namespace git {
	
	export class BlameCommit {
	    sha: string;
	    author: string;
	    authorTime: number;
	    summary: string;
	    uncommitted: boolean;
	
	    static createFrom(source: any = {}) {
	        return new BlameCommit(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.sha = source["sha"];
	        this.author = source["author"];
	        this.authorTime = source["authorTime"];
	        this.summary = source["summary"];
	        this.uncommitted = source["uncommitted"];
	    }
	}
	export class Blame {
	    commits: BlameCommit[];
	    lines: number[];
	
	    static createFrom(source: any = {}) {
	        return new Blame(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.commits = this.convertValues(source["commits"], BlameCommit);
	        this.lines = source["lines"];
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}
	
	export class Branch {
	    name: string;
	    upstream: string;
	    ahead: number;
	    behind: number;
	    detached: boolean;
	    unborn: boolean;
	
	    static createFrom(source: any = {}) {
	        return new Branch(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.name = source["name"];
	        this.upstream = source["upstream"];
	        this.ahead = source["ahead"];
	        this.behind = source["behind"];
	        this.detached = source["detached"];
	        this.unborn = source["unborn"];
	    }
	}
	export class FileStatus {
	    path: string;
	    staged: string;
	    worktree: string;
	    conflicted: boolean;
	    origPath: string;
	
	    static createFrom(source: any = {}) {
	        return new FileStatus(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.path = source["path"];
	        this.staged = source["staged"];
	        this.worktree = source["worktree"];
	        this.conflicted = source["conflicted"];
	        this.origPath = source["origPath"];
	    }
	}
	export class Status {
	    availability: string;
	    branch: Branch;
	    files: FileStatus[];
	
	    static createFrom(source: any = {}) {
	        return new Status(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.availability = source["availability"];
	        this.branch = this.convertValues(source["branch"], Branch);
	        this.files = this.convertValues(source["files"], FileStatus);
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}

}

export namespace kubeconfig {
	
	export class Context {
	    name: string;
	    cluster: string;
	    user: string;
	    namespace: string;
	    current: boolean;
	
	    static createFrom(source: any = {}) {
	        return new Context(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.name = source["name"];
	        this.cluster = source["cluster"];
	        this.user = source["user"];
	        this.namespace = source["namespace"];
	        this.current = source["current"];
	    }
	}
	export class Config {
	    contexts: Context[];
	    sources: string[];
	
	    static createFrom(source: any = {}) {
	        return new Config(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.contexts = this.convertValues(source["contexts"], Context);
	        this.sources = source["sources"];
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}

}

export namespace kubeexec {
	
	export class Result {
	    argv: string[];
	    exitCode: number;
	    stdout: string;
	    stderr: string;
	
	    static createFrom(source: any = {}) {
	        return new Result(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.argv = source["argv"];
	        this.exitCode = source["exitCode"];
	        this.stdout = source["stdout"];
	        this.stderr = source["stderr"];
	    }
	}

}

export namespace project {
	
	export class Binding {
	    context: string;
	    namespace: string;
	    protected: boolean;
	    serverSide: boolean;
	    scope: string;
	
	    static createFrom(source: any = {}) {
	        return new Binding(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.context = source["context"];
	        this.namespace = source["namespace"];
	        this.protected = source["protected"];
	        this.serverSide = source["serverSide"];
	        this.scope = source["scope"];
	    }
	}
	export class Helm {
	    defaultValues: string[];
	
	    static createFrom(source: any = {}) {
	        return new Helm(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.defaultValues = source["defaultValues"];
	    }
	}
	export class Scope {
	    path: string;
	    context: string;
	    namespace: string;
	    protected: boolean;
	
	    static createFrom(source: any = {}) {
	        return new Scope(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.path = source["path"];
	        this.context = source["context"];
	        this.namespace = source["namespace"];
	        this.protected = source["protected"];
	    }
	}
	export class Kube {
	    context: string;
	    namespace: string;
	    protected: boolean;
	    serverSide: boolean;
	    scopes: Scope[];
	
	    static createFrom(source: any = {}) {
	        return new Kube(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.context = source["context"];
	        this.namespace = source["namespace"];
	        this.protected = source["protected"];
	        this.serverSide = source["serverSide"];
	        this.scopes = this.convertValues(source["scopes"], Scope);
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}
	export class Project {
	    name: string;
	    path: string;
	    shortPath: string;
	    displayName: string;
	    color: string;
	    kube: Kube;
	    helm: Helm;
	
	    static createFrom(source: any = {}) {
	        return new Project(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.name = source["name"];
	        this.path = source["path"];
	        this.shortPath = source["shortPath"];
	        this.displayName = source["displayName"];
	        this.color = source["color"];
	        this.kube = this.convertValues(source["kube"], Kube);
	        this.helm = this.convertValues(source["helm"], Helm);
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}
	
	export class Settings {
	    displayName: string;
	    color: string;
	    kube: Kube;
	    helm: Helm;
	
	    static createFrom(source: any = {}) {
	        return new Settings(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.displayName = source["displayName"];
	        this.color = source["color"];
	        this.kube = this.convertValues(source["kube"], Kube);
	        this.helm = this.convertValues(source["helm"], Helm);
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}

}

export namespace session {
	
	export class Editor {
	    path: string;
	    mode: string;
	
	    static createFrom(source: any = {}) {
	        return new Editor(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.path = source["path"];
	        this.mode = source["mode"];
	    }
	}
	export class Terminal {
	    title: string;
	    cwd: string;
	
	    static createFrom(source: any = {}) {
	        return new Terminal(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.title = source["title"];
	        this.cwd = source["cwd"];
	    }
	}
	export class Project {
	    name: string;
	    editors: Editor[];
	    activeEditor: string;
	    terminals: Terminal[];
	    activeTerminal: number;
	    treeExpanded: string[];
	    treeSelected: string;
	    treeShowHidden: boolean;
	
	    static createFrom(source: any = {}) {
	        return new Project(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.name = source["name"];
	        this.editors = this.convertValues(source["editors"], Editor);
	        this.activeEditor = source["activeEditor"];
	        this.terminals = this.convertValues(source["terminals"], Terminal);
	        this.activeTerminal = source["activeTerminal"];
	        this.treeExpanded = source["treeExpanded"];
	        this.treeSelected = source["treeSelected"];
	        this.treeShowHidden = source["treeShowHidden"];
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}
	export class State {
	    version: number;
	    activeProject: string;
	    fontSize: number;
	    sidebar: number;
	    terminalHeight: number;
	    clusterWidth: number;
	    changedOnly: boolean;
	    projects: Project[];
	
	    static createFrom(source: any = {}) {
	        return new State(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.version = source["version"];
	        this.activeProject = source["activeProject"];
	        this.fontSize = source["fontSize"];
	        this.sidebar = source["sidebar"];
	        this.terminalHeight = source["terminalHeight"];
	        this.clusterWidth = source["clusterWidth"];
	        this.changedOnly = source["changedOnly"];
	        this.projects = this.convertValues(source["projects"], Project);
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}

}

export namespace stream {
	
	export class Endpoint {
	    port: number;
	    token: string;
	
	    static createFrom(source: any = {}) {
	        return new Endpoint(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.port = source["port"];
	        this.token = source["token"];
	    }
	}

}

export namespace tools {
	
	export class Tool {
	    name: string;
	    path: string;
	    version: string;
	    found: boolean;
	    problem: string;
	
	    static createFrom(source: any = {}) {
	        return new Tool(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.name = source["name"];
	        this.path = source["path"];
	        this.version = source["version"];
	        this.found = source["found"];
	        this.problem = source["problem"];
	    }
	}

}

export namespace watch {
	
	export class Entry {
	    name: string;
	    isDir: boolean;
	
	    static createFrom(source: any = {}) {
	        return new Entry(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.name = source["name"];
	        this.isDir = source["isDir"];
	    }
	}
	export class FileContent {
	    content: string;
	    crlf: boolean;
	    mixedEol: boolean;
	    readOnly: boolean;
	    size: number;
	
	    static createFrom(source: any = {}) {
	        return new FileContent(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.content = source["content"];
	        this.crlf = source["crlf"];
	        this.mixedEol = source["mixedEol"];
	        this.readOnly = source["readOnly"];
	        this.size = source["size"];
	    }
	}

}

