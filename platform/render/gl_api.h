/* The slice of OpenGL ES 3.0 / WebGL2 the GPU renderer uses, and nothing else.
 *
 * One list, two ways of binding it:
 *   - emscripten: the real GLES3 headers, calls go straight to WebGL2;
 *   - native: function pointers resolved at run time through whatever the
 *     host hands GlrInit (SDL_GL_GetProcAddress), so there is no GL import
 *     library, no GLEW, and no system GL header to depend on -- the
 *     constants below are the handful this code needs, with the values
 *     every GL since 3.0 agrees on.
 *
 * The same code runs on a GLES 3.0 context, a WebGL2 context and a desktop
 * 3.3 core context; the shaders differ only in their #version line.
 */
#ifndef GUARD_PORT_GL_API_H
#define GUARD_PORT_GL_API_H

#include <stddef.h>
#include <stdint.h>

#ifdef __EMSCRIPTEN__
#include <GLES3/gl3.h>
#define GLR_FN(name) name
#else

typedef unsigned int GLenum;
typedef unsigned char GLboolean;
typedef unsigned int GLbitfield;
typedef void GLvoid;
typedef int GLint;
typedef unsigned int GLuint;
typedef int GLsizei;
typedef float GLfloat;
typedef char GLchar;
typedef unsigned char GLubyte;
typedef ptrdiff_t GLsizeiptr;
typedef ptrdiff_t GLintptr;

#define GL_FALSE 0
#define GL_TRUE 1
#define GL_NO_ERROR 0
#define GL_TRIANGLES 0x0004
#define GL_TRIANGLE_STRIP 0x0005
#define GL_BLEND 0x0BE2
#define GL_DEPTH_TEST 0x0B71
#define GL_SCISSOR_TEST 0x0C11
#define GL_CULL_FACE 0x0B44
#define GL_UNPACK_ALIGNMENT 0x0CF5
#define GL_PACK_ALIGNMENT 0x0D05
#define GL_MAX_TEXTURE_SIZE 0x0D33
#define GL_TEXTURE_2D 0x0DE1
#define GL_UNSIGNED_BYTE 0x1401
#define GL_UNSIGNED_SHORT 0x1403
#define GL_INT 0x1404
#define GL_UNSIGNED_INT 0x1405
#define GL_FLOAT 0x1406
#define GL_COLOR 0x1800
#define GL_RED 0x1903
#define GL_RGBA 0x1908
#define GL_VENDOR 0x1F00
#define GL_RENDERER 0x1F01
#define GL_VERSION 0x1F02
#define GL_NEAREST 0x2600
#define GL_TEXTURE_MAG_FILTER 0x2800
#define GL_TEXTURE_MIN_FILTER 0x2801
#define GL_TEXTURE_WRAP_S 0x2802
#define GL_TEXTURE_WRAP_T 0x2803
#define GL_CLAMP_TO_EDGE 0x812F
#define GL_COLOR_BUFFER_BIT 0x00004000
#define GL_TEXTURE0 0x84C0
#define GL_ARRAY_BUFFER 0x8892
#define GL_STREAM_DRAW 0x88E0
#define GL_STATIC_DRAW 0x88E4
#define GL_FRAGMENT_SHADER 0x8B30
#define GL_VERTEX_SHADER 0x8B31
#define GL_COMPILE_STATUS 0x8B81
#define GL_LINK_STATUS 0x8B82
#define GL_INFO_LOG_LENGTH 0x8B84
#define GL_SHADING_LANGUAGE_VERSION 0x8B8C
#define GL_RGBA8 0x8058
#define GL_R8UI 0x8232
#define GL_R16UI 0x8234
#define GL_RGBA32I 0x8D82
#define GL_RGBA8UI 0x8D7C
#define GL_RED_INTEGER 0x8D94
#define GL_RGBA_INTEGER 0x8D99
#define GL_READ_FRAMEBUFFER 0x8CA8
#define GL_DRAW_FRAMEBUFFER 0x8CA9
#define GL_FRAMEBUFFER 0x8D40
#define GL_FRAMEBUFFER_COMPLETE 0x8CD5
#define GL_COLOR_ATTACHMENT0 0x8CE0
#define GL_BACK 0x0405
#define GL_LINEAR 0x2601
#define GL_RG8 0x822B
#define GL_RG 0x8227
#define GL_R32UI 0x8236
#define GL_RG32UI 0x823C
#define GL_RGBA32UI 0x8D70
#define GL_RG_INTEGER 0x8228
#define GL_ONE 1
#define GL_SRC_ALPHA 0x0302
#define GL_ONE_MINUS_SRC_ALPHA 0x0303
#define GL_FUNC_ADD 0x8006
#define GL_ELEMENT_ARRAY_BUFFER 0x8893
#define GL_DYNAMIC_DRAW 0x88E8
#endif

/* ret, name, (params) */
#define GLR_FUNCS(X) \
    X(const GLubyte *, glGetString, (GLenum)) \
    X(void, glGetIntegerv, (GLenum, GLint *)) \
    X(GLenum, glGetError, (void)) \
    X(void, glViewport, (GLint, GLint, GLsizei, GLsizei)) \
    X(void, glClearColor, (GLfloat, GLfloat, GLfloat, GLfloat)) \
    X(void, glClear, (GLbitfield)) \
    X(void, glEnable, (GLenum)) \
    X(void, glDisable, (GLenum)) \
    X(void, glGenTextures, (GLsizei, GLuint *)) \
    X(void, glDeleteTextures, (GLsizei, const GLuint *)) \
    X(void, glBindTexture, (GLenum, GLuint)) \
    X(void, glTexImage2D, (GLenum, GLint, GLint, GLsizei, GLsizei, GLint, GLenum, GLenum, const void *)) \
    X(void, glTexSubImage2D, (GLenum, GLint, GLint, GLint, GLsizei, GLsizei, GLenum, GLenum, const void *)) \
    X(void, glTexParameteri, (GLenum, GLenum, GLint)) \
    X(void, glActiveTexture, (GLenum)) \
    X(void, glPixelStorei, (GLenum, GLint)) \
    X(void, glGenFramebuffers, (GLsizei, GLuint *)) \
    X(void, glDeleteFramebuffers, (GLsizei, const GLuint *)) \
    X(void, glBindFramebuffer, (GLenum, GLuint)) \
    X(void, glFramebufferTexture2D, (GLenum, GLenum, GLenum, GLuint, GLint)) \
    X(GLenum, glCheckFramebufferStatus, (GLenum)) \
    X(void, glReadPixels, (GLint, GLint, GLsizei, GLsizei, GLenum, GLenum, void *)) \
    X(void, glClearBufferuiv, (GLenum, GLint, const GLuint *)) \
    X(void, glClearBufferfv, (GLenum, GLint, const GLfloat *)) \
    X(void, glDrawBuffers, (GLsizei, const GLenum *)) \
    X(void, glBlitFramebuffer, (GLint, GLint, GLint, GLint, GLint, GLint, GLint, GLint, GLbitfield, GLenum)) \
    X(GLuint, glCreateShader, (GLenum)) \
    X(void, glShaderSource, (GLuint, GLsizei, const GLchar *const *, const GLint *)) \
    X(void, glCompileShader, (GLuint)) \
    X(void, glGetShaderiv, (GLuint, GLenum, GLint *)) \
    X(void, glGetShaderInfoLog, (GLuint, GLsizei, GLsizei *, GLchar *)) \
    X(void, glDeleteShader, (GLuint)) \
    X(GLuint, glCreateProgram, (void)) \
    X(void, glAttachShader, (GLuint, GLuint)) \
    X(void, glLinkProgram, (GLuint)) \
    X(void, glGetProgramiv, (GLuint, GLenum, GLint *)) \
    X(void, glGetProgramInfoLog, (GLuint, GLsizei, GLsizei *, GLchar *)) \
    X(void, glUseProgram, (GLuint)) \
    X(GLint, glGetUniformLocation, (GLuint, const GLchar *)) \
    X(void, glUniform1i, (GLint, GLint)) \
    X(void, glUniform2i, (GLint, GLint, GLint)) \
    X(void, glUniform4i, (GLint, GLint, GLint, GLint, GLint)) \
    X(void, glUniform1iv, (GLint, GLsizei, const GLint *)) \
    X(void, glUniform2iv, (GLint, GLsizei, const GLint *)) \
    X(void, glUniform4iv, (GLint, GLsizei, const GLint *)) \
    X(void, glUniform1f, (GLint, GLfloat)) \
    X(void, glUniform2f, (GLint, GLfloat, GLfloat)) \
    X(void, glUniform2fv, (GLint, GLsizei, const GLfloat *)) \
    X(void, glUniform3f, (GLint, GLfloat, GLfloat, GLfloat)) \
    X(void, glUniform4f, (GLint, GLfloat, GLfloat, GLfloat, GLfloat)) \
    X(void, glUniform4fv, (GLint, GLsizei, const GLfloat *)) \
    X(void, glGenBuffers, (GLsizei, GLuint *)) \
    X(void, glBindBuffer, (GLenum, GLuint)) \
    X(void, glBufferData, (GLenum, GLsizeiptr, const void *, GLenum)) \
    X(void, glGenVertexArrays, (GLsizei, GLuint *)) \
    X(void, glBindVertexArray, (GLuint)) \
    X(void, glEnableVertexAttribArray, (GLuint)) \
    X(void, glVertexAttribIPointer, (GLuint, GLint, GLenum, GLsizei, const void *)) \
    X(void, glVertexAttribDivisor, (GLuint, GLuint)) \
    X(void, glDrawArrays, (GLenum, GLint, GLsizei)) \
    X(void, glDrawArraysInstanced, (GLenum, GLint, GLsizei, GLsizei)) \
    X(void, glBindAttribLocation, (GLuint, GLuint, const GLchar *)) \
    X(void, glBlendEquation, (GLenum)) \
    X(void, glBlendFuncSeparate, (GLenum, GLenum, GLenum, GLenum)) \
    X(void, glScissor, (GLint, GLint, GLsizei, GLsizei)) \
    X(void, glVertexAttribPointer, (GLuint, GLint, GLenum, GLboolean, GLsizei, const void *)) \
    X(void, glUniformMatrix4fv, (GLint, GLsizei, GLboolean, const GLfloat *)) \
    X(void, glDrawElements, (GLenum, GLsizei, GLenum, const void *))

#ifdef __cplusplus
extern "C" {
#endif
#ifndef __EMSCRIPTEN__
#ifdef _WIN32
#define GLR_APIENTRY __stdcall
#else
#define GLR_APIENTRY
#endif
#define GLR_DECLARE(ret, name, args) typedef ret (GLR_APIENTRY *PFN_glr_##name) args; \
    extern PFN_glr_##name glr_##name;
GLR_FUNCS(GLR_DECLARE)
#undef GLR_DECLARE
#define GLR_FN(name) glr_##name
#endif
#ifdef __cplusplus
}
#endif

#endif /* GUARD_PORT_GL_API_H */
