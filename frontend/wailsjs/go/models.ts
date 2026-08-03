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

