using System;
using System.IO;
using System.Net;

// Registered only in the isolated test PowerShell process. Production uses TLS.
public sealed class PackagerFixtureRequestCreator : IWebRequestCreate {
    public WebRequest Create(Uri uri) { return new PackagerFixtureRequest(uri); }
}
public sealed class PackagerFixtureRequest : WebRequest {
    private Uri uri;
    public PackagerFixtureRequest(Uri value) { uri = value; }
    public bool AllowAutoRedirect { get; set; }
    public int ReadWriteTimeout { get; set; }
    public override int Timeout { get; set; }
    public override WebResponse GetResponse() {
        if (AllowAutoRedirect || Timeout != 15000 || ReadWriteTimeout != 15000) throw new Exception("Unbounded request policy");
        if (ServicePointManager.SecurityProtocol != SecurityProtocolType.Tls12) throw new Exception("TLS 1.2 required for this request");
        return new PackagerFixtureResponse(uri);
    }
    public override void Abort() { }
}
public sealed class PackagerFixtureResponse : WebResponse {
    private Uri uri;
    public PackagerFixtureResponse(Uri value) { uri = value; }
    private string Mode { get { return Environment.GetEnvironmentVariable("ANANTA_UPDATE_DOWNLOAD_MODE"); } }
    public HttpStatusCode StatusCode { get { return Mode == "redirect" ? HttpStatusCode.Redirect : HttpStatusCode.OK; } }
    public override Uri ResponseUri { get { return uri; } }
    public override long ContentLength { get { return Mode == "oversize" ? 134217729 : -1; } }
    public override Stream GetResponseStream() {
        return Mode == "stream-oversize" ? (Stream)new PackagerOversizeStream() : File.OpenRead(Environment.GetEnvironmentVariable("ANANTA_UPDATE_ARTIFACT"));
    }
    public override void Close() { }
}
public sealed class PackagerOversizeStream : Stream {
    private long remaining = 134217729;
    public override int Read(byte[] buffer, int offset, int count) { int next = (int)Math.Min(count,remaining); remaining -= next; return next; }
    public override bool CanRead { get { return true; } }
    public override bool CanWrite { get { return false; } }
    public override bool CanSeek { get { return false; } }
    public override long Length { get { throw new NotSupportedException(); } }
    public override long Position { get { throw new NotSupportedException(); } set { throw new NotSupportedException(); } }
    public override void Flush() { }
    public override long Seek(long offset, SeekOrigin origin) { throw new NotSupportedException(); }
    public override void SetLength(long value) { throw new NotSupportedException(); }
    public override void Write(byte[] buffer, int offset, int count) { throw new NotSupportedException(); }
}
