/*
  Phaneron - Clustered, accelerated and cloud-fit video server, pre-assembled and in kit form.
  Copyright (C) 2020 Streampunk Media Ltd.

  This program is free software: you can redistribute it and/or modify
  it under the terms of the GNU General Public License as published by
  the Free Software Foundation, either version 3 of the License, or
  (at your option) any later version.

  This program is distributed in the hope that it will be useful,
  but WITHOUT ANY WARRANTY; without even the implied warranty of
  MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
  GNU General Public License for more details.

  You should have received a copy of the GNU General Public License
  along with this program.  If not, see <https://www.gnu.org/licenses/>.
  https://www.streampunk.media/ mailto:furnace@streampunk.media
  14 Ormiscaig, Aultbea, Achnasheen, IV22 2JJ  U.K.
*/

import { PackImpl, Interlace } from './packer'
import { KernelParams, OpenCLBuffer } from 'nodencl'

const yuv420p8Kernel = `
__kernel void read(__global uchar8* restrict inputY,
				   __global uchar2* restrict inputU,
				   __global uchar2* restrict inputV,
				   __global float4* restrict output,
				   __private unsigned int width,
				   __constant float4* restrict colMatrix,
				   __global float* restrict gammaLut,
				   __constant float4* restrict gamutMatrix) {
  uint item = get_global_id(0);
  bool lastItemOnLine = get_local_id(0) == get_local_size(0) - 1;

  // 64 output pixels per workItem = 8 input luma uchar8s per work item, 8 each u & v uchar2s per work item
  uint numPixels = lastItemOnLine && (0 != width % 8) ? width % 64 : 64;
  uint numLoops = numPixels / 8;
  uint remain = numPixels % 8;

  uint line = get_group_id(0) / 2; // ends up floored in opencl I hope
  uint odd = get_group_id(0) % 2;

  uint inOff = 8 * item;
  uint uvInOff = (line * get_local_size(0) + get_local_id(0)) * 8;
  uint outOff = width * get_group_id(0) + get_local_id(0) * 64;

  float4 colMatR = colMatrix[0];
  float4 colMatG = colMatrix[1];
  float4 colMatB = colMatrix[2];

  // optimise loading of the 3x3 gamut matrix
  float4 gamutMat0 = gamutMatrix[0];
  float4 gamutMat1 = gamutMatrix[1];
  float4 gamutMat2 = gamutMatrix[2];
  float3 gamutMatR = (float3)(gamutMat0.s0, gamutMat0.s1, gamutMat0.s2);
  float3 gamutMatG = (float3)(gamutMat0.s3, gamutMat1.s0, gamutMat1.s1);
  float3 gamutMatB = (float3)(gamutMat1.s2, gamutMat1.s3, gamutMat2.s0);

  for (uint i=0; i<numLoops; ++i) {
	uchar8 y = inputY[inOff];
	uchar2 u0 = inputU[uvInOff * 2];
	uchar2 v0 = inputV[uvInOff * 2];
	uchar2 u1 = inputU[uvInOff * 2 + 1];
	uchar2 v1 = inputV[uvInOff * 2 + 1];

	uchar4 yuva[8];
	yuva[0] = (uchar4)(y.s0, u0.s0, v0.s0, 1);
	yuva[1] = (uchar4)(y.s1, u0.s0, v0.s0, 1);
	yuva[2] = (uchar4)(y.s2, u0.s1, v0.s1, 1);
	yuva[3] = (uchar4)(y.s3, u0.s1, v0.s1, 1);
	yuva[4] = (uchar4)(y.s4, u1.s0, v1.s0, 1);
	yuva[5] = (uchar4)(y.s5, u1.s0, v1.s0, 1);
	yuva[6] = (uchar4)(y.s6, u1.s1, v1.s1, 1);
	yuva[7] = (uchar4)(y.s7, u1.s1, v1.s1, 1);

	for (uint p=0; p<8; ++p) {
	  float4 yuva_f = convert_float4(yuva[p]);
	  float3 rgb;
	  rgb.s0 = gammaLut[convert_ushort_sat_rte(dot(yuva_f, colMatR) * 65535.0f)];
	  rgb.s1 = gammaLut[convert_ushort_sat_rte(dot(yuva_f, colMatG) * 65535.0f)];
	  rgb.s2 = gammaLut[convert_ushort_sat_rte(dot(yuva_f, colMatB) * 65535.0f)];

	  float4 rgba;
	  rgba.s0 = dot(rgb, gamutMatR);
	  rgba.s1 = dot(rgb, gamutMatG);
	  rgba.s2 = dot(rgb, gamutMatB);
	  rgba.s3 = 1.0f;
	  output[outOff+p] = rgba;
	}

	inOff++;
	uvInOff += 1;
	outOff+=8;
  }

  if (remain > 0) {
	uchar8 y = inputY[inOff];
	uchar2 u = inputU[inOff];
	uchar2 v = inputV[inOff];

	uchar4 yuva[6];
	yuva[0] = (uchar4)(y.s0, u.s0, v.s0, 1);
	yuva[1] = (uchar4)(y.s1, u.s0, v.s0, 1);

	if (remain > 2) {
	  yuva[2] = (uchar4)(y.s2, u.s0, v.s0, 1);
	  yuva[3] = (uchar4)(y.s3, u.s0, v.s0, 1);

	  if (remain > 4) {
		yuva[4] = (uchar4)(y.s4, u.s1, v.s1, 1);
		yuva[5] = (uchar4)(y.s5, u.s1, v.s1, 1);
	  }
	}

	for (uint p=0; p<remain; ++p) {
	  float4 yuva_f = convert_float4(yuva[p]);
	  float3 rgb;
	  rgb.s0 = gammaLut[convert_ushort_sat_rte(dot(yuva_f, colMatR) * 65535.0f)];
	  rgb.s1 = gammaLut[convert_ushort_sat_rte(dot(yuva_f, colMatG) * 65535.0f)];
	  rgb.s2 = gammaLut[convert_ushort_sat_rte(dot(yuva_f, colMatB) * 65535.0f)];

	  float4 rgba;
	  rgba.s0 = dot(rgb, gamutMatR);
	  rgba.s1 = dot(rgb, gamutMatG);
	  rgba.s2 = dot(rgb, gamutMatB);
	  rgba.s3 = 1.0f;
	  output[outOff+p] = rgba;
	}
  }
}

__kernel void write(__global float4* restrict input,
					__global uchar8* restrict outputY,
					__global uchar2* restrict outputU,
					__global uchar2* restrict outputV,
					__private unsigned int width,
					__private unsigned int interlace,
					__constant float4* restrict colMatrix,
					__global float* restrict gammaLut) {
  bool lastItemOnLine = get_local_id(0) == get_local_size(0) - 1;

  // 64 input pixels per workItem = 8 input luma uchar8s per work item, 8 each u & v uchar4s per work item
  uint numPixels = lastItemOnLine && (0 != width % 8) ? width % 64 : 64;
  uint numLoops = numPixels / 8;
  uint remain = numPixels % 8;

  uint interlaceOff = (3 == interlace) ? 1 : 0;
	  uint line = get_group_id(0) * ((0 == interlace) ? 1 : 2) + interlaceOff;
  uint inOff = width * line + get_local_id(0) * 64;
	  uint outOff = width * line / 8 + get_local_id(0) * 8;

  if (64 != numPixels) {
	// clear the output buffers for the last item, partially overwritten below
	uint clearOff = outOff;
	for (uint i=0; i<numLoops; ++i) {
	  outputY[clearOff] = (uchar8)(64, 64, 64, 64, 64, 64, 64, 64);
	  outputU[clearOff] = (uchar2)(512, 512);
	  outputV[clearOff] = (uchar2)(512, 512);
	  clearOff++;
	}
  }

  float4 matY = colMatrix[0];
  float4 matU = colMatrix[1];
  float4 matV = colMatrix[2];

  for (uint i=0; i<numLoops; ++i) {
	uchar3 yuv[8];

	for (uint p=0; p<8; ++p) {
	  float4 rgba_l = input[inOff+p];
	  float4 rgba;
	  rgba.s0 = gammaLut[convert_ushort_sat_rte(rgba_l.s0 * 65535.0f)];
	  rgba.s1 = gammaLut[convert_ushort_sat_rte(rgba_l.s1 * 65535.0f)];
	  rgba.s2 = gammaLut[convert_ushort_sat_rte(rgba_l.s2 * 65535.0f)];
	  rgba.s3 = 1.0f;

	  yuv[p].s0 = convert_ushort_sat_rte(dot(rgba, matY));
	  yuv[p].s1 = convert_ushort_sat_rte(dot(rgba, matU));
	  yuv[p].s2 = convert_ushort_sat_rte(dot(rgba, matV));
	}

	uchar8 y = (uchar8)(yuv[0].s0, yuv[1].s0, yuv[2].s0, yuv[3].s0, yuv[4].s0, yuv[5].s0, yuv[6].s0, yuv[7].s0);
	uchar2 u = (uchar4)(yuv[0].s1, yuv[4].s1);
	uchar2 v = (uchar4)(yuv[0].s2, yuv[4].s2);
	outputY[outOff] = y;
	outputU[outOff] = u;
	outputV[outOff] = v;

	inOff+=8;
	outOff++;
  }

  if (remain > 0) {
	uchar8 y = (uchar8)(64, 64, 64, 64, 64, 64, 64, 64);
	uchar2 u = (uchar4)(512, 512);
	uchar2 v = (uchar4)(512, 512);

	uchar3 yuv[6];
	for (uint p=0; p<remain; ++p) {
	  float4 rgba_l = input[inOff+p];
	  float4 rgba;
	  rgba.s0 = gammaLut[convert_ushort_sat_rte(rgba_l.s0 * 65535.0f)];
	  rgba.s1 = gammaLut[convert_ushort_sat_rte(rgba_l.s1 * 65535.0f)];
	  rgba.s2 = gammaLut[convert_ushort_sat_rte(rgba_l.s2 * 65535.0f)];
	  rgba.s3 = 1.0;

	  yuv[p].s0 = convert_ushort_sat_rte(round(dot(rgba, matY)));
	  yuv[p].s1 = convert_ushort_sat_rte(round(dot(rgba, matU)));
	  yuv[p].s2 = convert_ushort_sat_rte(round(dot(rgba, matV)));
	}

	y.s0 = yuv[0].s0;
	y.s1 = yuv[1].s0;
	u.s0 = yuv[0].s1;
	v.s0 = yuv[0].s2;
	if (remain > 2) {
	  y.s2 = yuv[2].s0;
	  y.s3 = yuv[3].s0;
	  if (remain > 4) {
		y.s4 = yuv[4].s0;
		y.s5 = yuv[5].s0;
		u.s1 = yuv[4].s1;
		v.s1 = yuv[4].s2;
	  }
	}

	outputY[outOff] = y;
	outputU[outOff] = u;
	outputV[outOff] = v;
  }
}
`

function getPitch(width: number): number {
	return width + 7 - ((width - 1) % 8)
}

function getPitchBytes(width: number): number {
	return getPitch(width)
}

export function fillBuf(buf: Buffer, width: number, height: number): void {
	const lumaPitchBytes = getPitchBytes(width)
	const chromaPitchBytes = lumaPitchBytes / 4
	let lOff = 0
	let uOff = lumaPitchBytes * height
	let vOff = uOff + chromaPitchBytes * height

	buf.fill(0)
	let Y = 16
	const Cb = 128
	const Cr = 128
	for (let y = 0; y < height; ++y) {
		let xlOff = 0
		let xcOff = 0
		for (let x = 0; x < width; x += 2) {
			buf.writeUInt8(Y, lOff + xlOff)
			buf.writeUInt8(Y + 1, lOff + xlOff + 2)
			xlOff += 4

			buf.writeUInt8(Cb, uOff + xcOff)
			buf.writeUInt8(Cr, vOff + xcOff)
			xcOff += 2
			Y = 234 == Y ? 16 : (Y += 2)
		}
		lOff += lumaPitchBytes
		uOff += chromaPitchBytes
		vOff += chromaPitchBytes
	}
}

export function dumpBuf(buf: Buffer, width: number, height: number, numLines: number): void {
	const lumaPitchBytes = getPitchBytes(width)

	let yLineOff = 0
	let uLineOff = lumaPitchBytes * height
	let vLineOff = uLineOff + uLineOff / 2
	function getYHex(off: number): string {
		return buf.readUInt8(yLineOff + off * 2).toString(16)
	}
	function getUHex(off: number): string {
		return buf.readUInt8(uLineOff + off).toString(16)
	}
	function getVHex(off: number): string {
		return buf.readUInt8(vLineOff + off).toString(16)
	}

	for (let l = 0; l < numLines; ++l) {
		yLineOff = lumaPitchBytes * l
		uLineOff = yLineOff + lumaPitchBytes * height
		vLineOff = uLineOff + (lumaPitchBytes * height) / 2
		console.log(
			`Line ${l}: ${getUHex(0)}, ${getYHex(0)}, ${getVHex(0)}, ${getYHex(1)}; ${getUHex(
				2
			)}, ${getYHex(2)}, ${getVHex(2)}, ${getYHex(3)}; ${getUHex(4)}, ${getYHex(4)}, ${getVHex(
				4
			)}, ${getYHex(5)}; ${getUHex(6)}, ${getYHex(6)}, ${getVHex(6)}, ${getYHex(7)}`
		)
	}
}

// process 1 image line per work group
const pixelsPerWorkItem = 64

export class Reader extends PackImpl {
	constructor(width: number, height: number) {
		super('yuv420p8', width, height, yuv420p8Kernel, 'read')
		this.numBits = 8
		this.lumaBlack = 16
		this.lumaWhite = 235
		this.chromaRange = 224
		this.isRGB = false
		const lumaBytes = getPitchBytes(this.width) * this.height // width rounded up to multiple of 8
		this.numBytes = [lumaBytes, lumaBytes / 4, lumaBytes / 4] // 4 luma = 1 chroma
		this.workItemsPerGroup = getPitch(this.width) / pixelsPerWorkItem
		this.globalWorkItems = this.workItemsPerGroup * this.height
		console.log('constructed yuv420p reader')
	}

	getKernelParams(params: KernelParams): KernelParams {
		const srcArray: Array<OpenCLBuffer> = params.sources as Array<OpenCLBuffer>
		if (srcArray.length !== 3)
			throw new Error(`Reader for ${this.name} requires 'sources' parameter with 3 OpenCL buffers`)
		return {
			inputY: srcArray[0],
			inputU: srcArray[1],
			inputV: srcArray[2],
			output: params.dest,
			width: this.width,
			colMatrix: params.colMatrix,
			gammaLut: params.gammaLut,
			gamutMatrix: params.gamutMatrix
		}
	}
}

export class Writer extends PackImpl {
	constructor(width: number, height: number, interlaced: boolean) {
		super('yuv420p8', width, height, yuv420p8Kernel, 'write')
		this.interlaced = interlaced
		this.numBits = 8
		this.lumaBlack = 16
		this.lumaWhite = 235
		this.chromaRange = 224
		this.isRGB = false
		const lumaBytes = getPitchBytes(this.width) * this.height
		this.numBytes = [lumaBytes, lumaBytes / 2, lumaBytes / 2]
		this.workItemsPerGroup = getPitch(this.width) / pixelsPerWorkItem
		this.globalWorkItems = (this.workItemsPerGroup * this.height) / (this.interlaced ? 2 : 1)
	}

	getKernelParams(params: KernelParams): KernelParams {
		const dstArray: Array<OpenCLBuffer> = params.dests as Array<OpenCLBuffer>
		if (dstArray.length !== 3)
			throw new Error(`Writer for ${this.name} requires 'dests' parameter with 3 OpenCL buffers`)
		return {
			input: params.source,
			outputY: dstArray[0],
			outputU: dstArray[1],
			outputV: dstArray[2],
			width: this.width,
			interlace: this.interlaced ? (params.interlace as Interlace) : Interlace.Progressive,
			colMatrix: params.colMatrix,
			gammaLut: params.gammaLut
		}
	}
}
